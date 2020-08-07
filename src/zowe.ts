import {Command} from '@oclif/command'
import {execSync} from 'child_process'
import * as newDebug from 'debug'

const debug = newDebug('zowe')

export interface ZoweResult {
  success: boolean;
  exitCode: number;
  message: string;
  stdout: string;
  stderr: string;
  data: {};
}

export interface ZoweOptions {
  direct?: boolean;
  logOutput?: boolean;
  throwError?: boolean;
}

export interface ApiResponse {
  apiResponse: {
    items: [];
    totalRows: number;
    returnedRows: number;
    JSONversion: number;
  };
}

function logResult(result: ZoweResult) {
  if (result.stdout.trim().length > 0) {
    process.stdout.write(result.stdout.trim())
    process.stdout.write('\n')
  }
  if (result.stderr.trim().length > 0) {
    process.stdout.write(result.stderr.trim())
    process.stdout.write('\n')
  }
}

export function zoweSync(command: string, options?: ZoweOptions): ZoweResult {
  const defaultOptions: ZoweOptions = {direct: false, logOutput: true, throwError: true}
  if (options === undefined) {
    options = defaultOptions
  }
  const direct = options.direct === undefined ? defaultOptions.direct : options.direct
  const logOutput = options.logOutput === undefined ? defaultOptions.logOutput : options.logOutput
  const throwError = options.throwError === undefined ? defaultOptions.throwError : options.throwError

  try {
    debug(command)
    if (!direct) {
      const json: string = execSync(`zowe --rfj ${command}`, {encoding: 'utf8'})
      if (!json) {
        /* eslint no-throw-literal: "off" */
        // noinspection ExceptionCaughtLocallyJS
        throw {stdout: ''}
      }
      const result: ZoweResult = JSON.parse(json)
      debug(result)
      if (logOutput) {
        logResult(result)
      }
      return result
    }
    execSync(`zowe ${command}`, {stdio: 'inherit'})
    return {success: true, exitCode: 0, message: '', stdout: '', stderr: '', data: {}}
  } catch (error) {
    debug(error)
    let result: ZoweResult
    try {
      result = error.stdout ? JSON.parse(error.stdout) : {
        data: {},
        exitCode: -1,
        message: 'empty JSON response from Zowe CLI',
        stderr: '',
        stdout: '',
        success: false,
      }
      debug(result)
    } catch (error2) {
      throw error
    }

    if (throwError) {
      if (result) {
        throw new Error(result.message || result.stderr || result.stdout)
      } else {
        throw error
      }
    }
    if (logOutput) {
      logResult(result)
    }
    return result
  }
}

export function checkZowe(command: Command, _zosmfProfiles: string[]) {
  try {
    const zosmfProfiles = zoweSync('profiles list zosmf-profiles', {logOutput: false}).data as []
    debug(zosmfProfiles)
    if (zosmfProfiles.length === 0) {
      command.error(
        'No zosmf-profile defined in Zowe CLI. Use "zowe profiles create zosmf-profile" to define it'
      )
    }
  } catch (error) {
    if (error.message.indexOf('command not found') > -1) {
      command.error('Zowe CLI is not installed. Use "npm install -g @zowe/cli" to install it')
    } else {
      throw error
    }
  }
}

export function zosExistsSync(zosFile: string): boolean {
  const data = zoweSync(`files list uss ${zosFile}`, {throwError: false, logOutput: false}).data as ApiResponse
  try {
    return data.apiResponse.totalRows === 1
  } catch (error) {
    return false
  }
}
