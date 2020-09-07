import {Command, flags} from '@oclif/command'
import {existsSync, promises, readFileSync, unlinkSync} from 'fs'
import {join, resolve} from 'path'
import * as tmp from 'tmp'
import {
  AbstractSession,
  CliProfileManager,
  Imperative,
  ImperativeConfig,
  IProfileLoaded,
  Session,
} from '@zowe/imperative'
import {Create, CreateDataSetTypeEnum, Download, List, sleep, Upload, ZosmfSession} from '@zowe/cli'
import {PerfTiming} from '@zowe/perf-timing'
import parse from 'parse-duration'

const filesizeParser = require('filesize-parser')
const winston = require('winston')

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  defaultMeta: { service: 'user-service' },
  transports: [
    new winston.transports.File({ filename: 'requests-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'requests.log' }),
  ],
})

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
  static description = 'Zowe z/OSMF Test of Performance'

  static flags = {
    // add --version flag to show CLI version
    version: flags.version({char: 'v'}),
    help: flags.help({char: 'h'}),
  }

  static args = [{name: 'file', required: true, description: 'Test definition file'}]

  async userActivity(userNumber: number, testDefinition: TestDefinition, zosmfProfilesByName: { [name: string]: IProfileLoaded }): Promise<ActivityStats> {
    const scriptDelay = parse(testDefinition.scriptDelay) || 1000
    const commandDelay = parse(testDefinition.commandDelay) || 1000
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

    const {tmpCobolPath, testDsn} = await this.prepareTestData(testDefinition, userid, userNumber, session)

    const tests = [
      // zowe files upload ftds
      {
        name: 'DatasetUpload', action: async function () {
          const response = await Upload.fileToDataset(session, tmpCobolPath, testDsn + '(TEST1)')
          return response
        },
      },
      // zowe files download ds
      {
        name: 'DatasetDownload', action: async function () {
          const tmpDownloadPath = tmp.tmpNameSync()
          const response = await Download.dataSet(session, testDsn + '(TEST1)', {file: tmpDownloadPath})
          unlinkSync(tmpDownloadPath)
          return response
        },
      },
      // TODO:
      // zowe files upload ftu [JA]
      // zowe files download uf [JA]
      // zowe tso issue command [JA]
      // zowe console issue command
      // zowe console collect sr
      // zowe jobs submit [PP]
      // zowe jobs view [PP]
      // zowe jobs download [PP]
    ]

    let successfulRequests = 0
    let failedRequests = 0
    const startTime = new Date().getTime()
    let requestNumber = 0
    while (new Date().getTime() - startTime <= duration) {
      requestNumber++
      const scriptStartTime = new Date().getTime()

      for (const test of tests) {
        const commandStartTime = new Date().getTime()
        PerfTiming.api.mark('Before' + test.name)
        const response = await test.action() // eslint-disable-line no-await-in-loop
        PerfTiming.api.mark('After' + test.name)
        const responseString = JSON.stringify(response)
        if (response.success) {
          PerfTiming.api.measure(test.name, 'Before' + test.name, 'After' + test.name)
          successfulRequests++
          logger.info(`User #${userNumber} ${userid} - Request ${requestNumber} - Test ${test.name}: ${responseString}`)
        } else {
          PerfTiming.api.measure(test.name + 'Failed', 'Before' + test.name, 'After' + test.name)
          failedRequests++
          logger.error(`User #${userNumber} ${userid} - Request ${requestNumber} - Test ${test.name}: ${responseString}`)
        }

        await sleep(Math.max(commandDelay - (new Date().getTime() - commandStartTime), 0)) // eslint-disable-line no-await-in-loop
      }

      await sleep(Math.max(scriptDelay - (new Date().getTime() - scriptStartTime), 0)) // eslint-disable-line no-await-in-loop
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
    const testNames = ['DatasetUpload', 'DatasetDownload']
    for (const measurement of PerfTiming.api.getMetrics().measurements) {
      for (const testName of testNames) {
        if (measurement.name === testName) {
          this.log(`Average successful ${testName}: ${measurement.averageDuration} ms`)
        }
        if (measurement.name === testName + 'Failed') {
          this.log(`Average failed ${testName}: ${measurement.averageDuration} ms`)
        }
      }
    }
    this.log('Total activity count', JSON.stringify(totalActivityStats))
  }

  private async prepareTestData(testDefinition: TestDefinition, userid: string, userNumber: number, session: Session) {
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
    return {tmpCobolPath, testDsn}
  }
}

export = Zztop
