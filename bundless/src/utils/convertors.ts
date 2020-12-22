import path from 'path'
import { cleanUrl } from './utils'

export const dotdotEncoding = '...'

export function importPathToFile(root: string, request: string) {
    request = decodeURIComponent(request)
    request = cleanUrl(request)
    request = request.startsWith('/') ? request.slice(1) : request
    request = path.resolve(root, request)
    request = request.replace(/\.\.\./g, '..')
    return request
}

export function fileToImportPath(root: string, filePath: string) {
    filePath = path.resolve(root, filePath)
    filePath = path.relative(root, filePath)
    filePath = filePath.replace(/\.\./g, dotdotEncoding)
    filePath = '/' + filePath
    return filePath
}
