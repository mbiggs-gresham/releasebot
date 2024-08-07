const semverVersionTypes = ['major', 'minor', 'patch']

/**
 * This function will take the contents of a package.json file and replace the version number with the next version number.
 * @param fileContents
 * @param nextVersion
 */
export function patchPackageJson(fileContents: string, nextVersion: string): string {
  return fileContents.replace(/"version": "(.*)"/, `"version": "${nextVersion}"`)
}

export function isValidSemverVersionType(version: string): boolean {
  return semverVersionTypes.includes(version)
}
