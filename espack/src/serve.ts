import chalk from 'chalk'
import chokidar, { FSWatcher, watch } from 'chokidar'
import deepmerge from 'deepmerge'
import { Server } from 'http'
import Koa, { DefaultContext, DefaultState } from 'koa'
import { listen } from 'listhen'
import path from 'path'
import slash from 'slash'
import WebSocket from 'ws'
import { HMRPayload } from './client/types'
import { Config } from './config'
import {
    DEFAULT_PORT,
    HMR_SERVER_NAME,
    JS_EXTENSIONS,
    WEB_MODULES_PATH,
} from './constants'
import { Graph } from './graph'
import { onFileChange } from './hmr'
import { logger } from './logger'
import * as middlewares from './middleware'
import { createPluginsExecutor, PluginsExecutor } from './plugin'
import {
    CssPlugin,
    EsbuildTransformPlugin,
    NodeResolvePlugin,
    ResolveSourcemapPlugin,
    RewritePlugin,
    SourcemapPlugin,
    HmrClientPlugin,
} from './plugins'
import { prebundle } from './prebundle'
import { BundleMap } from './prebundle/esbuild'
import { osAgnosticPath } from './prebundle/support'
import { genSourceMapString } from './sourcemaps'
import {
    isCSSRequest,
    isNodeModule,
    importPathToFile,
    dotdotEncoding,
} from './utils'

const debug = require('debug')('espack')
export interface ServerPluginContext {
    root: string
    app: Koa
    pluginExecutor: PluginsExecutor
    // server: Server
    watcher: FSWatcher
    server?: Server
    config: Config
    sendHmrMessage: (payload: HMRPayload) => void
    port: number
}

export type ServerMiddleware = (ctx: ServerPluginContext) => void

export async function serve(config: Config) {
    const app = createApp(config)
    const { server, close } = await listen(app.callback(), {
        port: config.port || DEFAULT_PORT,
        showURL: true,
        // open: true,
    })
    app.context.server = server
    const port = server.address()?.['port']
    app.context.port = port
    config.port = port
    return {
        ...server,
        close: () => {
            app.emit('close')
            return close()
        },
    }
}

export function createApp(config: Config) {
    config = deepmerge({ root: process.cwd() }, config)

    const { root = process.cwd() } = config

    const app = new Koa<DefaultState, DefaultContext>()

    const graph = new Graph({ root })
    let bundleMap: BundleMap | undefined
    const pluginExecutor = createPluginsExecutor({
        root,
        plugins: [
            HmrClientPlugin({ getPort: () => app.context.port }),
            NodeResolvePlugin({
                extensions: [...JS_EXTENSIONS],
                async onResolved(resolvedPath) {
                    if (!isNodeModule(resolvedPath)) {
                        return
                    }
                    const relativePath = slash(
                        path.relative(root, resolvedPath),
                    )
                    if (bundleMap && bundleMap[relativePath]) {
                        return bundleMap[relativePath]
                    }
                    // node module path not bundled, rerun bundling
                    const entryPoints = [...Object.keys(graph.nodes)].map((x) =>
                        path.resolve(root, x),
                    )
                    bundleMap = await prebundle({
                        entryPoints,
                        dest: path.resolve(root, WEB_MODULES_PATH),
                        root: root,
                    }).catch((e) => {
                        throw new Error(`Cannot prebundle: ${e}`)
                    })
                    const webBundle = bundleMap[relativePath]
                    if (!webBundle) {
                        throw new Error(
                            `Bundle for '${relativePath}' was not generated in prebundling phase\n${JSON.stringify(
                                bundleMap,
                                null,
                                4,
                            )}`,
                        )
                    }
                    return webBundle
                    // lock server, start optimization, unlock, send refresh message
                },
            }),
            // NodeModulesPolyfillPlugin(),
            EsbuildTransformPlugin(),
            RewritePlugin(),
            ResolveSourcemapPlugin(),
            SourcemapPlugin(),
            CssPlugin(),
            ...(config.plugins || []),
        ],
        config,
        graph,
    })

    app.once('close', () => {
        logger.debug('closing')
        pluginExecutor.close({})
    })

    const watcher = chokidar.watch(root, {
        // cwd: root,
        // disableGlobbing: true,
        ignored: ['**/node_modules/**', '**/.git/**'],
        ignoreInitial: true,
        //   ...chokidarWatchOptions
    })

    // changing anything inside root that is not ignored and that is not in graph will cause reload
    watcher.on('change', (filePath) => {
        onFileChange({
            graph,
            filePath,
            root,
            sendHmrMessage: context.sendHmrMessage,
        })
    })

    const context: ServerPluginContext = {
        root,
        app,
        watcher,
        config,
        pluginExecutor,
        sendHmrMessage: () => {
            // assigned in the hmr middleware
            logger.log(`hmr ws server has not started yet`)
        },
        // port is exposed on the context for hmr client connection
        // in case the files are served under a different port
        port: Number(config.port || 3000),
    }

    const pluginsMiddleware: ServerMiddleware = ({ app }) => {
        // attach server context to koa context
        app.use(async (ctx, next) => {
            Object.assign(ctx, context)
            // TODO skip assets, css and other assets loaded from <link> should not get processed, how? put the assets resolver first?
            // TODO now i am skipping non js code from running inside onTransform, onLoad and onResolve, but is should be able to run onTransform on html for example
            if (ctx.path == '/') {
                return next()
            }
            const req = ctx.req
            if (
                // esm imports accept */* in most browsers
                !(
                    (
                        req.headers['accept'] === '*/*' ||
                        req.headers['sec-fetch-dest'] === 'script' ||
                        ctx.path.endsWith('.map')
                    ) // css imported from js should have content type header '*/*'
                )
            ) {
                return next()
            }

            if (ctx.path.startsWith('.')) {
                throw new Error(
                    `All import paths should have been rewritten to absolute paths (start with /)\n` +
                        ` make sure import paths for '${ctx.path}' are statically analyzable`,
                )
            }

            // TODO how to handle virtual files? virtual files will be resolved to a path here, i want them to remain as is
            // i can rely on the namespace in query to load them correctly inside onLoad, in resolvers i can keep in mind that these paths will be prefixed by the root, /path/to/root/::virtual-file
            const filePath = importPathToFile(root, ctx.path)

            // watch files outside root
            if (
                ctx.path.startsWith('/' + dotdotEncoding) &&
                !filePath.includes('node_modules')
            ) {
                watcher.add(filePath)
            }

            const loaded = await pluginExecutor.load({
                path: filePath,
                namespace: '',
            })
            if (loaded == null || loaded.contents == null) {
                return next()
            }
            const transformed = await pluginExecutor.transform({
                path: filePath,
                loader: loaded.loader,
                contents: String(loaded.contents),
            })
            if (transformed == null) {
                return next()
            }

            const sourcemap = transformed.map
                ? genSourceMapString(transformed.map)
                : ''

            ctx.body = transformed.contents + sourcemap
            ctx.type = 'js' // TODO how to set right content type? an html transform could return html, should esbuild support custom content types? should i extend esbuild result types?
        })
    }
    const hmrMiddleware: ServerMiddleware = ({ app }) => {
        const wss = new WebSocket.Server({ noServer: true })
        let done = false
        app.use((_, next) => {
            if (done) {
                return next()
            }
            app.once('close', () => {
                wss.close(() => logger.debug('closing wss'))
                wss.clients.forEach((client) => {
                    client.close()
                })
            })
            app.context.server.on('upgrade', (req, socket, head) => {
                if (req.headers['sec-websocket-protocol'] === HMR_SERVER_NAME) {
                    wss.handleUpgrade(req, socket, head, (ws) => {
                        wss.emit('connection', ws, req)
                    })
                }
            })

            wss.on('connection', (socket) => {
                debug('ws client connected')
                socket.send(JSON.stringify({ type: 'connected' }))
                wss.on('message', (data) => {
                    const message: HMRPayload = JSON.parse(data.toString())
                    if (message.type === 'hotAccept') {
                        const entry = graph.ensureEntry(
                            importPathToFile(root, message.path),
                        )
                        entry.hasHmrAccept = true
                        entry.isHmrEnabled = true
                    }
                })
            })

            wss.on('error', (e: Error & { code: string }) => {
                if (e.code !== 'EADDRINUSE') {
                    console.error(chalk.red(`WebSocket server error:`))
                    console.error(e)
                }
            })

            context.sendHmrMessage = (payload: HMRPayload) => {
                const stringified = JSON.stringify(payload, null, 4)
                logger.log(`hmr: ${stringified}`)

                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(stringified)
                    }
                })
            }
            done = true
            return next()
        })
    }

    app.use((_, next) => {
        console.log(graph.toString())
        return next()
    })

    const serverMiddleware = [
        hmrMiddleware,
        middlewares.pluginAssetsMiddleware,
        pluginsMiddleware,
        middlewares.serveStaticMiddleware,
    ]
    for (const middleware of serverMiddleware) {
        middleware(context)
    }

    // cors
    if (config.cors) {
        app.use(
            require('@koa/cors')(
                typeof config.cors === 'boolean' ? {} : config.cors,
            ),
        )
    }

    return app
}
