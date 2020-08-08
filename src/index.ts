import {Command, flags} from '@oclif/command'
import {existsSync, readFileSync, writeFileSync} from 'fs'
import {join, resolve} from 'path'
import * as tmp from 'tmp'
import {AbstractSession, CliProfileManager, Imperative, ImperativeConfig, IProfileLoaded} from '@zowe/imperative'
import {Create, CreateDataSetTypeEnum, List, ZosmfSession, Upload, sleep} from "@zowe/cli";
import {PerfTiming} from "@zowe/perf-timing";

const filesizeParser = require('filesize-parser')

interface TestDefinition {
  name: string;
  fileSize: string;
  memberSize: string;
  jobOutputSize: string;
  tsoCommandOutputSize: string;
  duration: string;
  commandDelay: string;
  concurrentUsers: number;
  zosmfProfiles: string[];
  dsnSecondSegment: string;
}

async function initializeImperative() {
  const mainZoweDir = join(require.resolve('@zowe/cli'), '..', '..', '..', '..');
  (process.mainModule as any).filename = require.resolve('@zowe/cli');
  ((process.mainModule as any).paths as any).unshift(mainZoweDir);
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

  async run() {
    const {args} = this.parse(Zztop)
    if (!PerfTiming.isEnabled) {
      this.error("PerfTiming is not enabled. Set environment variables: PERF_TIMING_ENABLED=TRUE PERF_TIMING_IO_MAX_HISTORY=1 PERF_TIMING_IO_SAVE_DIR=.", {exit: 1})
    }

    this.log(`Test definition file: ${args.file}`)
    if (!existsSync(args.file)) {
      this.error(`File ${resolve(args.file)} does not exist`)
    }
    const testDefinition: TestDefinition = JSON.parse(readFileSync(args.file, 'utf8'))
    this.log(`${JSON.stringify(testDefinition, null, 2)}`)
    await initializeImperative();

    const profiles = await new CliProfileManager({
      profileRootDirectory: join(ImperativeConfig.instance.cliHome, 'profiles'),
      type: `zosmf`
    }).loadAll();

    const zosmfProfiles = profiles.filter((profile) => {
      return profile.type === `zosmf`;
    });

    let zosmfProfilesByName: { [name: string]: IProfileLoaded } = {}

    for (const profile of zosmfProfiles) {
      if (profile.name) {
        zosmfProfilesByName[profile.name] = profile
      }
    }

    const profileName = testDefinition.zosmfProfiles[0]
    const profile = zosmfProfilesByName[profileName]
    if (profile && profile.profile) {
      const userid = profile.profile.user
      this.log(`Userid: ${userid}`)
      const session = ZosmfSession.createBasicZosmfSession(profile.profile);

      const tmpCobolPath = tmp.tmpNameSync()
      const lineCount = filesizeParser(testDefinition.memberSize) / 80
      const result = " 04110     DISPLAY 'HELLO, WORLD' UPON CONSL.                           00170000\n".repeat(lineCount)
      writeFileSync(tmpCobolPath, result)
      const testDsn = userid.toUpperCase() + "." + testDefinition.dsnSecondSegment + ".TEST1"
      const exists = await datasetExists(session, testDsn)
      if (!exists) {
        const response = await Create.dataSet(session, CreateDataSetTypeEnum.DATA_SET_CLASSIC, testDsn)
        if (!response.success) {
          this.error(response.commandResponse, {exit: 1})
        }
      }
      PerfTiming.api.mark("BeforeDatasetUpload")
      const uploadResponse = await Upload.fileToDataset(session, tmpCobolPath, testDsn + "(MEMBER1)")
      PerfTiming.api.mark("AfterDatasetUpload")
      this.log(JSON.stringify(uploadResponse))
    } else {
      this.error(`Invalid profile name: ${profileName}`)
    }

    PerfTiming.api.measure("DatasetUpload", "BeforeDatasetUpload", "AfterDatasetUpload")
    await sleep(1000)
    this.log(JSON.stringify(PerfTiming.api.getMetrics().measurements, null, 2))


    // const dsn =
    // if (!zosExistsSync()
    // zowe  zos-files create data-set-classic NEW.CLASSIC.DATASET
    // zoweSync(`files upload ftds ${tmpCobolPath} `)
  }
}

export = Zztop
