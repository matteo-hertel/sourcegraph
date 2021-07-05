import esbuild from 'esbuild'
import path from 'path'
//import sassPlugin from 'esbuild-plugin-sass-modules'
// import { sassPlugin } from 'esbuild-sass-plugin'
import cssModulesPlugin from 'esbuild-css-modules-plugin'
import sass from 'sass'
import postcss from 'postcss'
import postcssConfig from './postcss.config.js'
import postcssModules from 'postcss-modules'
import fs from 'fs'
import os from 'os'

/** @type esbuild.Plugin */
const examplePlugin = {
    name: 'example',
    setup: build => {
        build.onResolve({ filter: /./, namespace: 'file' }, args => {
            if (args.path.endsWith('.css')) {
                //console.log('onResolve', args)
            }
        })
    },
}

const resolveFile = (modulePath, dir) => {
    if (modulePath.startsWith('wildcard/')) {
        return path.resolve(`node_modules/@sourcegraph/${modulePath}`)
    }

    if (modulePath.startsWith('wildcard/') || modulePath.startsWith('shared')) {
        return path.resolve(`client/${modulePath}`)
    }
    if (
        modulePath.startsWith('@reach') ||
        modulePath.startsWith('graphiql') ||
        modulePath.startsWith('@sourcegraph') ||
        modulePath.startsWith('bootstrap') ||
        modulePath.startsWith('open-color') ||
        modulePath.startsWith('react-grid-layout') ||
        !modulePath.startsWith('.')
    ) {
        let p = path.resolve(`node_modules/${modulePath}`)
        try {
            p = fs.realpathSync(p)
        } catch (err) {}
        return p
    }
    return path.resolve(dir, modulePath)
}

/** @type esbuild.Plugin */
const sassPlugin = {
    name: 'sass',
    setup: build => {
        const tmpDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'esbuild-'))
        // const tmpDirPath = '/tmp/esbuild-JeD7YX'

        /** @type {path:string; map: {[key: string]: string}}[] */
        const modulesMap = []
        const modulesPlugin = postcssModules({
            generateScopedName: '[name]__[local]___[hash:base64:5]',
            localsConvention: 'camelCase',
            modules: true,
            getJSON(filepath, json, outpath) {
                // Make sure to replace json map instead of pushing new map everytime with edit file on watch
                const mapIndex = modulesMap.findIndex(m => m.path === filepath)
                if (mapIndex !== -1) {
                    modulesMap[mapIndex].map = json
                } else {
                    modulesMap.push({
                        path: filepath,
                        map: json,
                    })
                }
            },
        })

        build.onResolve({ filter: /\.s?css$/, namespace: 'file' }, async args => {
            // Namespace is empty when using CSS as an entrypoint
            if (args.namespace !== 'file' && args.namespace !== '') {
                return
            }

            const sourceFullPath = resolveFile(args.path, args.resolveDir)

            const sourceExt = path.extname(sourceFullPath)
            const sourceBaseName = path.basename(sourceFullPath, sourceExt)
            const sourceDir = path.dirname(sourceFullPath)
            const sourceRelDir = path.relative(path.dirname(process.cwd()), sourceDir)
            const isModule = sourceBaseName.endsWith('.module')
            const tmpDir = path.resolve(tmpDirPath, sourceRelDir)

            const tmpFilePath =
                args.kind === 'entry-point'
                    ? path.join(tmpDir, `${sourceBaseName}.css`)
                    : path.resolve(tmpDir, `${Date.now()}-${sourceBaseName}.css`)

            fs.mkdirSync(tmpDir, { recursive: true })

            const fileContent = fs.readFileSync(sourceFullPath)
            let css
            switch (sourceExt) {
                case '.css':
                    css = fileContent
                    break

                case '.scss':
                    css = sass
                        .renderSync({
                            file: sourceFullPath,
                            includePaths: ['node_modules', 'client'],
                            importer: (url, prev, done) => {
                                return { file: resolveFile(url) }
                            },
                            quiet: true,
                        })
                        .css.toString()
                    break

                default:
                    throw new Error(`unknown file extension: ${sourceExt}`)
            }

            const result = await postcss({
                ...postcssConfig,
                plugins: isModule ? [...postcssConfig.plugins, modulesPlugin] : postcssConfig.plugins,
            }).process(css, {
                from: sourceFullPath,
                to: tmpFilePath,
            })

            fs.writeFileSync(tmpFilePath, result.css)

            return {
                namespace: isModule ? 'postcss-module' : 'file',
                path: tmpFilePath,
                watchFiles: [sourceFullPath],
                pluginData: {
                    originalPath: sourceFullPath,
                },
            }
        })
        build.onResolve({ filter: /\.ttf$/ }, args => {
            // TODO(sqs): hack, need to resolve this from the original path
            if (args.path === './codicon.ttf') {
                return {
                    path: path.resolve('node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon', args.path),
                }
            }
        })
        build.onResolve({ filter: /\.png$/ }, args => {
            // TODO(sqs): hack, need to resolve this from the original path
            if (args.path === 'img/bg-sprinkles-2x.png') {
                return {
                    path: path.resolve('ui/assets', args.path),
                }
            }
        })

        build.onLoad({ filter: /./, namespace: 'postcss-module' }, async args => {
            const mod = modulesMap.find(({ path }) => path === args.pluginData.originalPath)
            const resolveDir = path.dirname(args.path)

            const contents = `import ${JSON.stringify(args.path)}
            export default ${JSON.stringify(mod && mod.map ? mod.map : {})}`

            return {
                resolveDir,
                contents,
            }
        })

        // Handle the `import`ed CSS files from the previous onLoad filter.
        build.onResolve({ filter: /./, namespace: 'postcss-module' }, args => {
            return {
                path: args.path,
                namespace: 'file',
            }
        })
    },
}

esbuild
    .build({
        entryPoints: ['client/web/src/enterprise/main.tsx'],
        bundle: true,
        format: 'esm',
        outdir: 'ui/assets/esbuild',
        logLevel: 'error',
        splitting: false,
        plugins: [sassPlugin],
        define: {
            'process.env.NODE_ENV': '"development"',
            global: 'window',
            'process.env.SOURCEGRAPH_API_URL': '"' + process.env.SOURCEGRAPH_API_URL + '"',
        },
        loader: {
            '.yaml': 'text',
            // '.scss': 'css',
            // '.css': 'text',
            '.ttf': 'dataurl',
            '.png': 'dataurl',
        },
        target: 'es2020',
        sourcemap: true,
    })
    .catch(e => console.error(e.message))