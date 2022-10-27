import url from 'node:url'
import path from 'node:path'

import logger from '@wdio/logger'
import { createRequire } from 'node:module'

import type { Plugin } from 'vite'
import {
    WebDriverProtocol, MJsonWProtocol, JsonWProtocol, AppiumProtocol,
    ChromiumProtocol, SauceLabsProtocol, SeleniumProtocol, GeckoProtocol,
    WebDriverBidiProtocol
} from '@wdio/protocols'

import { SESSIONS } from '../constants.js'
import { getTemplate, getErrorTemplate } from '../utils.js'

const log = logger('@wdio/browser-runner:plugin')
const require = createRequire(import.meta.url)
const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

const commands = {
    ...WebDriverProtocol,
    ...MJsonWProtocol,
    ...JsonWProtocol,
    ...AppiumProtocol,
    ...ChromiumProtocol,
    ...SauceLabsProtocol,
    ...SeleniumProtocol,
    ...GeckoProtocol,
    ...WebDriverBidiProtocol
}
const protocolCommandList = Object.values(commands).map(
    (endpoint) => Object.values(endpoint).map(
        ({ command }) => command
    )
).flat()
const WDIO_PACKAGES = ['webdriverio']
const virtualModuleId = 'virtual:wdio'
const resolvedVirtualModuleId = '\0' + virtualModuleId

const MODULES_TO_MOCK = [
    'node:module', 'node:events', 'node:url', 'puppeteer-core', 'archiver', '/devtools/build/index.js',
    'query-selector-shadow-dom/plugins'
]

export function testrunner (options: WebdriverIO.BrowserRunnerOptions): Plugin {
    const root = options.rootDir || process.cwd()
    const automationProtocolPath = path.resolve(__dirname, '..', 'browser', 'driver.js')
    console.log(automationProtocolPath)

    const mockModulePath = path.resolve(__dirname, '..', 'browser', 'mock.js')
    const globalModulePath = path.resolve(__dirname, '..', 'browser', 'global.js')
    return {
        name: 'wdio:testrunner',
        enforce: 'pre',
        resolveId: (id) => {
            if (id === virtualModuleId) {
                return resolvedVirtualModuleId
            }

            /**
             * make sure WDIO imports are resolved properly as ESM module
             */
            if (id.startsWith('@wdio') || WDIO_PACKAGES.includes(id)) {
                if (id === '@wdio/globals') {
                    return globalModulePath
                }

                return require.resolve(id).replace('/cjs', '')
            }

            /**
             * mock out imports that we can't transpile into browser land
             */
            if (MODULES_TO_MOCK.find((m) => id.includes(m))) {
                return mockModulePath
            }
        },
        load(id) {
            /**
             * provide a list of protocol commands to generate the prototype in the browser
             */
            if (id === resolvedVirtualModuleId) {
                return /*js*/`
                    export const commands = ${JSON.stringify(protocolCommandList)}
                    export const automationProtocolPath = ${JSON.stringify(automationProtocolPath)}
                `
            }
        },
        transform(code, id) {
            if (id.includes('.vite/deps/expect.js')) {
                return {
                    code: code.replace(
                        'var fs = _interopRequireWildcard(require_graceful_fs());',
                        'var fs = {};'
                    ).replace(
                        'var expect_default = require_build11();',
                        'var expect_default = require_build11();\nwindow.expect = expect_default.default;'
                    ).replace(
                        'process.stdout.isTTY',
                        'false'
                    )
                }
            }
            return { code }
        },
        configureServer (server) {
            return () => {
                server.middlewares.use('/', async (req, res, next) => {
                    log.info(`Received request for: ${req.url}`)
                    if (!req.url) {
                        return next()
                    }

                    const urlParsed = url.parse(req.url)
                    // if request is not html , directly return next()
                    if (!urlParsed.pathname || !urlParsed.path || !urlParsed.pathname.endsWith('test.html')) {
                        return next()
                    }

                    const urlParamString = new URLSearchParams(urlParsed.query || '')
                    const cid = urlParamString.get('cid')
                    const spec = urlParamString.get('spec')
                    if (!cid || !SESSIONS.has(cid)) {
                        log.error(`No environment found for ${cid || 'non determined environment'}`)
                        return next()
                    }

                    if (!spec) {
                        log.error('No spec file was defined to run for this environment')
                        return next()
                    }

                    const env = SESSIONS.get(cid)!
                    try {
                        const template = await getTemplate(options, env, path.join(root, spec))
                        log.debug(`Render template for ${req.url}`)
                        res.end(await server.transformIndexHtml(`${req.url}`, template))
                    } catch (err: any) {
                        const template = await getErrorTemplate(req.url, err)
                        log.error(`Failed to render template: ${err.message}`)
                        res.end(await server.transformIndexHtml(`${req.url}`, template))
                    }

                    return next()
                })
            }
        }
    }
}
