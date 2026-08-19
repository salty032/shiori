import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(readFileSync(join(appDir, 'package-lock.json'), 'utf8'))
const outputPath = join(appDir, 'generated', 'THIRD-PARTY-LICENSES.txt')
const licenseFilePattern = /^(licen[cs]e|copying|notice)(\..+)?$/i

const mitLicense = (copyright) => `MIT License

Copyright (c) ${copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

// These npm tarballs declare MIT but omit the upstream LICENSE file.
// Keep the upstream copyright notice here; unknown omissions must fail below.
const missingLicenseFallbacks = {
  'lazy-val': mitLicense('Vladimir Krivosheev'),
  'onnxruntime-common': mitLicense('Microsoft Corporation'),
  'onnxruntime-node': mitLicense('Microsoft Corporation'),
  'screenshot-desktop': mitLicense('Ben Evans'),
}

const packages = []
for (const [relativePath, lockEntry] of Object.entries(lock.packages ?? {})) {
  if (!relativePath.includes('node_modules/') || lockEntry.dev === true) continue

  const packageDir = join(appDir, relativePath)
  const packageJsonPath = join(packageDir, 'package.json')
  if (!existsSync(packageJsonPath)) continue

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const files = readdirSync(packageDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && licenseFilePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))

  let notices = files.map((name) => ({
    name,
    text: readFileSync(join(packageDir, name), 'utf8').trim(),
  }))

  if (notices.length === 0) {
    const fallback = missingLicenseFallbacks[packageJson.name]
    if (!fallback || packageJson.license !== 'MIT') {
      throw new Error(
        `${packageJson.name}@${packageJson.version} has no license file. ` +
          'Verify its upstream license and add an explicit fallback.',
      )
    }
    notices = [{ name: 'LICENSE (upstream fallback)', text: fallback }]
  }

  packages.push({
    name: packageJson.name,
    version: packageJson.version,
    license: packageJson.license ?? lockEntry.license ?? 'Not declared',
    notices,
  })
}

packages.sort((a, b) =>
  `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'),
)

const uniquePackages = []
for (const item of packages) {
  const previous = uniquePackages.at(-1)
  if (previous?.name === item.name && previous.version === item.version) {
    if (previous.license !== item.license) {
      throw new Error(`Conflicting licenses for ${item.name}@${item.version}`)
    }
    for (const notice of item.notices) {
      if (!previous.notices.some((existing) => existing.text === notice.text)) {
        previous.notices.push(notice)
      }
    }
  } else {
    uniquePackages.push(item)
  }
}

const separator = '\n' + '='.repeat(80) + '\n'
const sections = uniquePackages.map(({ name, version, license, notices }) => {
  const noticeText = notices
    .map(({ name: fileName, text }) => `--- ${fileName} ---\n\n${text}`)
    .join('\n\n')
  return `${name}@${version}\nDeclared license: ${license}\n\n${noticeText}`
})

const header = `THIRD-PARTY SOFTWARE LICENSES

This file is generated from the production dependencies installed by
package-lock.json. It does not cover Shiori itself, FFmpeg, the WD Tagger model,
or icon assets; see NOTICE.md and the separately bundled license files for those.

Production npm packages: ${uniquePackages.length}`

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${header}${separator}${sections.join(separator)}\n`, 'utf8')
console.log(`Wrote ${outputPath} (${uniquePackages.length} packages)`)
