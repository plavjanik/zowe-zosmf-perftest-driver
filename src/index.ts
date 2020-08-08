import {Command, flags} from '@oclif/command'
import {existsSync, readFileSync, promises} from 'fs'
import {join, resolve} from 'path'
import * as tmp from 'tmp'
import {AbstractSession, CliProfileManager, Imperative, ImperativeConfig, IProfileLoaded} from '@zowe/imperative'
import {Create, CreateDataSetTypeEnum, List, ZosmfSession, Upload, sleep} from '@zowe/cli'
import {PerfTiming} from '@zowe/perf-timing'
import parse from 'parse-duration'

const filesizeParser = require('filesize-parser')

interface TestDefinition {
  name: string;
  fileSize: string;
  memberSize: string;
  jobOutputSize: string;
  tsoCommandOutputSize: string;
  duration: string;
  commandDelay: string;
  scriptDelay: string;
  concurrentUsers: number;
  zosmfProfiles: string[];
  dsnSecondSegment: string;
}

interface ActivityStats {
  successfulRequests: number;
  failedRequests: number;
}

async function initializeImperative() {
  const mainZoweDir = join(require.resolve('@zowe/cli'), '..', '..', '..', '..');
  (process.mainModule as any).filename = require.resolve('@zowe/cli');
  ((process.mainModule as any).paths as any).unshift(mainZoweDir)
  await Imperative.init({configurationModule: require.resolve('@zowe/cli/lib/imperative.js')})
}

async function datasetExists(session: AbstractSession, dsn: string): Promise<boolean> {
  const response = await List.dataSet(session, dsn)
  try {
    return response.apiResponse.returnedRows === 1
  } catch (error) {
    return false
  }
}

class Zztop extends Command {
  static description = 'describe the command here'

  static flags = {
    // add --version flag to show CLI version
    version: flags.version({char: 'v'}),
    help: flags.help({char: 'h'}),
  }

  static args = [{name: 'file', required: true, description: 'Test definition file'}]

  async userActivity(userNumber: number, testDefinition: TestDefinition, zosmfProfilesByName: { [name: string]: IProfileLoaded }): Promise<ActivityStats> {
    const scriptDelay = parse(testDefinition.scriptDelay) || 1000
    const duration = parse(testDefinition.duration) || 1000
    await sleep(scriptDelay * userNumber)

    const profileName = testDefinition.zosmfProfiles[userNumber % testDefinition.zosmfProfiles.length]
    const profile = zosmfProfilesByName[profileName]
    if (!profile || !profile.profile) {
      this.error(`Invalid profile name: ${profileName}`)
      return {failedRequests: 0, successfulRequests: 0}
    }

    const userid = profile.profile.user
    this.log(`Userid #${userNumber}: ${userid}`)
    const session = ZosmfSession.createBasicZosmfSession(profile.profile)

    const tmpCobolPath = tmp.tmpNameSync()
    const lineCount = filesizeParser(testDefinition.memberSize) / 80
    const result = " 04110     DISPLAY 'HELLO, WORLD' UPON CONSL.                           00170000\n".repeat(lineCount)
    await promises.writeFile(tmpCobolPath, result)
    const testDsn = userid.toUpperCase() + '.' + testDefinition.dsnSecondSegment + `.U${userNumber}`
    this.log(testDsn)
    const exists = await datasetExists(session, testDsn)
    if (!exists) {
      const response = await Create.dataSet(session, CreateDataSetTypeEnum.DATA_SET_CLASSIC, testDsn)
      if (!response.success) {
        this.error(response.commandResponse, {exit: 2})
      }
    }

    let successfulRequests = 0
    let failedRequests = 0
    const startTime = new Date().getTime()
    while (new Date().getTime() - startTime <= duration) {
      PerfTiming.api.mark('BeforeDatasetUpload')
      const uploadResponse = await Upload.fileToDataset(session, tmpCobolPath, testDsn + '(TEST1)') // eslint-disable-line no-await-in-loop
      PerfTiming.api.mark('AfterDatasetUpload')
      PerfTiming.api.measure('DatasetUpload', 'BeforeDatasetUpload', 'AfterDatasetUpload')
      this.log(JSON.stringify(uploadResponse))
      if (uploadResponse.success) {
        successfulRequests++
      } else {
        failedRequests++
      }

      await sleep(scriptDelay) // eslint-disable-line no-await-in-loop
    }

    return {failedRequests: failedRequests, successfulRequests: successfulRequests}
  }

  async run() {
    const {args} = this.parse(Zztop)

    this.log(`Test definition file: ${args.file}`)
    if (!existsSync(args.file)) {
      this.error(`File ${resolve(args.file)} does not exist`)
    }

    if (!PerfTiming.isEnabled) {
      this.error('PerfTiming is not enabled. Set environment variables: PERF_TIMING_ENABLED=TRUE PERF_TIMING_IO_MAX_HISTORY=1 PERF_TIMING_IO_SAVE_DIR=.', {exit: 1})
    }

    const testDefinition: TestDefinition = JSON.parse(readFileSync(args.file, 'utf8'))
    this.log(`${JSON.stringify(testDefinition, null, 2)}`)
    await initializeImperative()

    const profiles = await new CliProfileManager({
      profileRootDirectory: join(ImperativeConfig.instance.cliHome, 'profiles'),
      type: 'zosmf',
    }).loadAll()

    const zosmfProfiles = profiles.filter(profile => {
      return profile.type === 'zosmf'
    })

    const zosmfProfilesByName: { [name: string]: IProfileLoaded } = {}

    for (const profile of zosmfProfiles) {
      if (profile.name) {
        zosmfProfilesByName[profile.name] = profile
      }
    }

    const promises: Promise<ActivityStats>[] = []
    for (let i = 0; i < testDefinition.concurrentUsers; i++) {
      promises.push(this.userActivity(i, testDefinition, zosmfProfilesByName))
    }

    const allActivityStats = await Promise.all(promises)
    const totalActivityStats = {successfulRequests: 0, failedRequests: 0}
    for (const stats of allActivityStats) {
      totalActivityStats.successfulRequests += stats.successfulRequests
      totalActivityStats.failedRequests += stats.failedRequests
    }

    await sleep(1000)
    for (const measurement of PerfTiming.api.getMetrics().measurements) {
      if (measurement.name === 'DatasetUpload') {
        this.log(`Average DatasetUpload: ${measurement.averageDuration} ms`)
      }
    }
    this.log('Total activity count', JSON.stringify(totalActivityStats))
  }
}

export = Zztop
