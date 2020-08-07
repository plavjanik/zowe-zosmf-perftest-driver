import {Command, flags} from '@oclif/command'
import {existsSync, readFileSync, writeFileSync} from 'fs'
import {resolve} from 'path'
import {checkZowe} from './zowe'
import * as tmp from 'tmp'
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

    this.log(`Test definition file: ${args.file}`)
    if (!existsSync(args.file)) {
      this.error(`File ${resolve(args.file)} does not exist`)
    }
    const testDefinition: TestDefinition = JSON.parse(readFileSync(args.file, 'utf8'))
    this.log(`${JSON.stringify(testDefinition, null, 2)}`)

    checkZowe(this, testDefinition.zosmfProfiles)

    const tmpCobolPath = tmp.tmpNameSync()
    const lineCount = filesizeParser(testDefinition.memberSize) / 80
    const result = " 04110     DISPLAY 'HELLO, WORLD' UPON CONSL.                           00170000".repeat(lineCount)
    writeFileSync(tmpCobolPath, result)

    // const userid = testDefinition.
    // const dsn =
    // if (!zosExistsSync()
    // zowe  zos-files create data-set-classic NEW.CLASSIC.DATASET
    // zoweSync(`files upload ftds ${tmpCobolPath} `)
  }
}

export = Zztop
