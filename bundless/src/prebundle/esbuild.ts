import {
    HtmlIngestPlugin,
    NodeModulesPolyfillPlugin,
    NodeResolvePlugin,
} from '@esbuild-plugins/all'
import * as esbuild from 'esbuild'
import { Metadata } from 'esbuild'
import fromEntries from 'fromentries'
import fs from 'fs-extra'
import path from 'path'
import toUnixPath from 'slash'
import tmpfile from 'tmpfile'
import {
    importableFiles as importableImagesExtensions,
    JS_EXTENSIONS,
    MAIN_FIELDS,
} from '../constants'
import { DependencyStatsOutput } from './stats'
import {
    fixMetaPath,
    OptimizeAnalysisResult,
    osAgnosticPath,
    runFunctionOnPaths,
} from './support'

export const commonEsbuildOptions: esbuild.BuildOptions = {
    target: 'es2020',
    minify: false,
    minifyIdentifiers: false,
    minifySyntax: false,
    minifyWhitespace: false,
    mainFields: MAIN_FIELDS,
    sourcemap: false,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: true,
    logLevel: 'error',
    loader: {
        '.js': 'jsx',
        '.cjs': 'js',
        ...Object.assign(
            {},
            ...importableImagesExtensions.map((k) => ({
                [k]: 'file',
            })),
        ),
    },
}

export const resolvableExtensions = [
    ...JS_EXTENSIONS,
    ...importableImagesExtensions,
    '.json',
    '.css',
]

export async function bundleWithEsBuild({
    entryPoints,
    root,
    dest: destLoc,
    ...options
}) {
    const {
        env = {},
        alias = {},
        externalPackages = [],
        minify = false,
    } = options

    const metafile = path.join(destLoc, './meta.json')
    // const entryPoints = [...Object.values(installEntrypoints)]

    const tsconfigTempFile = tmpfile('.json')
    await fs.promises.writeFile(tsconfigTempFile, makeTsConfig({ alias }))

    // rimraf.sync(destLoc) // do not delete or on flight imports will return 404
    const buildResult = await esbuild.build({
        ...commonEsbuildOptions,
        splitting: true, // needed to dedupe modules
        external: externalPackages,
        minify: Boolean(minify),
        minifyIdentifiers: Boolean(minify),
        minifySyntax: Boolean(minify),
        minifyWhitespace: Boolean(minify),
        mainFields: MAIN_FIELDS,
        tsconfig: tsconfigTempFile,
        bundle: true,
        write: false,
        entryPoints,
        outdir: destLoc,
        metafile,
        define: {
            // TODO add defines from config, add to frontend injecting them to window
            'process.env.NODE_ENV': JSON.stringify('dev'),
            global: 'window',
            ...generateEnvReplacements(env),
        },
        inject: [
            require.resolve('@esbuild-plugins/node-globals-polyfill/process'),
        ],
        plugins: [
            // HtmlIngestPlugin(),
            NodeModulesPolyfillPlugin(),
            NodeResolvePlugin({
                mainFields: MAIN_FIELDS,
                extensions: resolvableExtensions,
            }),
        ],
    })

    // TODO use esbuild write to not load files in memory after https://github.com/yarnpkg/berry/issues/2259 gets fixed
    for (let outputFile of buildResult.outputFiles || []) {
        const filePath = outputFile.path.replace('$$virtual', 'virtual')
        await fs.ensureDir(path.dirname(filePath))
        await fs.writeFile(filePath, outputFile.contents)
    }

    await fs.promises.unlink(tsconfigTempFile)

    let meta = JSON.parse(
        await (await fs.promises.readFile(metafile)).toString(),
    )

    meta = runFunctionOnPaths(meta)
    const esbuildCwd = process.cwd()
    const bundleMap = metafileToBundleMap({
        entryPoints,
        meta,
        esbuildCwd,
        root,
    })

    const analysis = metafileToAnalysis({ meta, root, esbuildCwd })

    const stats = metafileToStats({ meta, destLoc })

    return { stats, bundleMap, analysis }
}

function makeTsConfig({ alias }) {
    const aliases = Object.keys(alias || {}).map((k) => {
        return {
            [k]: [alias[k]],
        }
    })
    const tsconfig = {
        compilerOptions: { baseUrl: '.', paths: Object.assign({}, ...aliases) },
    }

    return JSON.stringify(tsconfig)
}

export type BundleMap = Partial<Record<string, string>>

function metafileToBundleMap(_options: {
    entryPoints: string[]
    root: string
    esbuildCwd: string
    meta: Metadata
}): BundleMap {
    const { entryPoints, meta, root, esbuildCwd } = _options
    const inputFiles = new Set(entryPoints.map((x) => path.resolve(root, x)))

    const maps: Array<[string, string]> = Object.keys(meta.outputs)
        .map((output): [string, string] | undefined => {
            // chunks cannot be entrypoints
            if (path.basename(output).startsWith('chunk.')) {
                return
            }
            const inputs = Object.keys(meta.outputs[output].inputs)
            const input = inputs
                .map((x) => path.resolve(esbuildCwd, x))
                .find((x) => inputFiles.has(x))
            if (!input) {
                return
            }
            // const specifier = inputFilesToSpecifiers[input]
            return [
                osAgnosticPath(input, root),
                osAgnosticPath(path.resolve(esbuildCwd, output), root),
            ]
        })
        .filter(Boolean) as any

    const bundleMap = fromEntries(maps)

    return bundleMap
}

function metafileToAnalysis(_options: {
    meta: Metadata
    root: string
    esbuildCwd: string
}): OptimizeAnalysisResult {
    const { meta, root, esbuildCwd } = _options
    const analysis: OptimizeAnalysisResult = {
        isCommonjs: fromEntries(
            Object.keys(meta.outputs)
                .map((output): [string, true] | undefined => {
                    if (path.basename(output).startsWith('chunk.')) {
                        return
                    }
                    const info = meta.outputs[output]
                    if (!info) {
                        throw new Error(`cannot find output info for ${output}`)
                    }
                    const isCommonjs =
                        info.exports?.length === 1 &&
                        info.exports?.[0] === 'default'
                    if (!isCommonjs) {
                        return
                    }
                    // what if imported path ahs not yet been converted by prebundler? then prebundler should lock server, it's impossible
                    return [
                        osAgnosticPath(path.resolve(esbuildCwd, output), root),
                        isCommonjs,
                    ]
                })
                .filter(Boolean) as any,
        ),
    }
    return analysis
}

function metafileToStats(_options: {
    meta: Metadata
    destLoc: string
}): DependencyStatsOutput {
    const { meta, destLoc } = _options
    const stats = Object.keys(meta.outputs).map((output) => {
        const value = meta.outputs[output]
        // const inputs = meta.outputs[output].bytes;
        return {
            path: output,
            isCommon: ['chunk.'].some((x) =>
                path.basename(output).startsWith(x),
            ),
            bytes: value.bytes,
        }
    })

    function makeStatObject(value) {
        const relativePath = toUnixPath(path.relative(destLoc, value.path))
        return {
            [relativePath]: {
                size: value.bytes,
                // gzip: zlib.gzipSync(contents).byteLength,
                // brotli: zlib.brotliCompressSync ? zlib.brotliCompressSync(contents).byteLength : 0,
            },
        }
    }

    return {
        common: Object.assign(
            {},
            ...stats.filter((x) => x.isCommon).map(makeStatObject),
        ),
        direct: Object.assign(
            {},
            ...stats.filter((x) => !x.isCommon).map(makeStatObject),
        ),
    }
}

function generateEnvReplacements(env: Object): { [key: string]: string } {
    return Object.keys(env).reduce((acc, key) => {
        acc[`process.env.${key}`] = JSON.stringify(env[key])
        return acc
    }, {})
}
