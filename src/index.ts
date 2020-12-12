import { configure, getLogger } from "log4js";
import { Command, flags } from "@oclif/command";
import { existsSync, promises, readFileSync, Stats, unlinkSync } from "fs";
import { join, resolve } from "path";
import * as tmp from "tmp";
import {
  AbstractSession,
  CliProfileManager,
  Imperative,
  ImperativeConfig,
  IProfileLoaded,
  Session,
} from "@zowe/imperative";
import {
  CheckStatus,
  Create,
  CreateDataSetTypeEnum,
  Delete,
  DeleteJobs,
  Download,
  GetJobs,
  IssueCommand,
  IssueTso,
  List,
  MonitorJobs,
  sleep,
  SubmitJobs,
  Upload,
  ZosmfSession,
} from "@zowe/cli";
import { execSync } from "child_process";
import parse from "parse-duration";

const filesizeParser = require("filesize-parser");
const logger = getLogger("zztop");
const loggerRequest = getLogger("zztopRequest");

const testNames = [
  "DatasetUpload",
  "DatasetDownload",
  "FileUpload",
  "FileDownload",
  "TsoCommand",
  "ConsoleCommand",
  "JobSubmit",
  "JobView",
  "JobDownload",
];

interface TestDefinition {
  name: string;
  fileSize: string;
  memberSize: string;
  jobOutputSize: string;
  duration: string;
  commandDelay: string;
  initialScriptDelay: string;
  scriptDelay: string;
  concurrentUsers: number;
  zosmfProfiles: string[];
  dsnSecondSegment: string;
  unixDir: string;
  accountCode: string;
  jobCard: string[];
  selectedTestNames: string[];
}

interface Test {
  name: string;
  action: any;
}

interface Duration {
  duration: number;
  requestNumber: number;
  userNumber: number;
  testName: string;
  success: boolean;
}

interface ActivityStats {
  successfulRequests: number;
  failedRequests: number;
  durations: Duration[];
}

async function initializeImperative() {
  const mainZoweDir = join(
    require.resolve("@zowe/cli"),
    "..",
    "..",
    "..",
    ".."
  );
  (process.mainModule as any).filename = require.resolve("@zowe/cli");
  ((process.mainModule as any).paths as any).unshift(mainZoweDir);
  await Imperative.init({
    configurationModule: require.resolve("@zowe/cli/lib/imperative.js"),
  });
}

async function datasetExists(
  session: AbstractSession,
  dsn: string
): Promise<boolean> {
  const response = await List.dataSet(session, dsn);
  try {
    return response.apiResponse.returnedRows === 1;
  } catch (error) {
    return false;
  }
}

class Zztop extends Command {
  static description = "Zowe z/OSMF Test of Performance";

  static flags = {
    // add --version flag to show CLI version
    version: flags.version({ char: "v" }),
    help: flags.help({ char: "h" }),
    logLevel: flags.string({
      char: "l",
      description: "Log level (debug, info)",
      default: "info",
    }),
  };

  static args = [
    { name: "file", required: true, description: "Test definition file" },
  ];

  async userActivity(
    userNumber: number,
    testDefinition: TestDefinition,
    zosmfProfilesByName: { [name: string]: IProfileLoaded }
  ): Promise<ActivityStats> {
    const scriptDelay = parse(testDefinition.scriptDelay) || 1000;
    const commandDelay = parse(testDefinition.commandDelay) || 1000;
    const initialScriptDelay =
      parse(testDefinition.initialScriptDelay) || commandDelay;
    const duration = parse(testDefinition.duration) || 1000;
    await sleep(initialScriptDelay * userNumber);

    const profileName =
      testDefinition.zosmfProfiles[
        userNumber % testDefinition.zosmfProfiles.length
      ];
    const profile = zosmfProfilesByName[profileName];
    if (!profile || !profile.profile) {
      this.error(`Invalid profile name: ${profileName}`);
      return { failedRequests: 0, successfulRequests: 0, durations: [] };
    }

    const userid = profile.profile.user;
    this.log(`Userid #${userNumber}: ${userid}`);
    const session = ZosmfSession.createBasicZosmfSession(profile.profile);

    try {
      const {
        tmpCobolPath,
        testDsn,
        testJobname,
        testJobid,
        testSpoolId,
        testJcl,
        testUploadUssPath,
      } = await this.prepareTestData(
        testDefinition,
        userid,
        userNumber,
        session
      );

      this.log(`Running tests for ${userNumber} - ${userid}`);

      const allTests: Test[] = [
        // zowe files upload ftds
        {
          name: "DatasetUpload",
          action: async function () {
            return Upload.fileToDataset(
              session,
              tmpCobolPath,
              testDsn + "(TEST1)"
            );
          },
        },
        // zowe files download ds
        {
          name: "DatasetDownload",
          action: async function () {
            const tmpDownloadPath = tmp.tmpNameSync();
            const response = await Download.dataSet(
              session,
              testDsn + "(TEST1)",
              { file: tmpDownloadPath }
            );
            unlinkSync(tmpDownloadPath);
            return response;
          },
        },
        // zowe files upload ftu
        {
          name: "FileUpload",
          action: async function () {
            return Upload.fileToUssFile(
              session,
              tmpCobolPath,
              testUploadUssPath
            );
          },
        },
        // zowe files download uf
        {
          name: "FileDownload",
          action: async function () {
            const tmpDownloadPath = tmp.tmpNameSync();
            const response = await Download.ussFile(
              session,
              `${testDefinition.unixDir}/test${userNumber}_${userid}.txt`,
              { file: tmpDownloadPath }
            );
            unlinkSync(tmpDownloadPath);
            return response;
          },
        },
        // zowe tso issue command
        {
          name: "TsoCommand",
          action: async function () {
            const response = await IssueTso.issueTsoCommand(
              session,
              testDefinition.accountCode,
              `SEND 'Hello' USER(${userid})`
            );
            return response;
          },
        },
        // zowe console issue command
        {
          name: "ConsoleCommand",
          action: async function () {
            return IssueCommand.issue(session, { command: "D IPLINFO" });
          },
        },
        // zowe jobs submit
        {
          name: "JobSubmit",
          action: async function () {
            const job = await SubmitJobs.submitJcl(session, testJcl);
            const cleanup = async function () {
              await MonitorJobs.waitForOutputStatus(
                session,
                job.jobname,
                job.jobid
              );
              await DeleteJobs.deleteJob(session, job.jobname, job.jobid);
            };
            const promise = cleanup();
            return { success: true, job: job, cleanupPromise: promise };
          },
        },
        // zowe jobs view
        {
          name: "JobView",
          action: async function () {
            const spoolFiles = await GetJobs.getSpoolFiles(
              session,
              testJobname,
              testJobid
            );
            return { success: spoolFiles.length > 0, spoolFiles: spoolFiles };
          },
        },
        // zowe jobs download
        {
          name: "JobDownload",
          action: async function () {
            const spoolContent = await GetJobs.getSpoolContentById(
              session,
              testJobname,
              testJobid,
              testSpoolId
            );
            return { success: spoolContent.length > 0, content: spoolContent };
          },
        },
      ];

      const tests: Test[] = [];
      for (const test of allTests) {
        if (testNames.indexOf(test.name) === -1) {
          this.error(
            `Internal error: ${test.name} is not a valid test name: ${testNames}`
          );
        }
        if (
          !testDefinition.selectedTestNames ||
          testDefinition.selectedTestNames.indexOf(test.name) !== -1
        ) {
          tests.push(test);
        }
      }

      let successfulRequests = 0;
      let failedRequests = 0;
      const startTime = new Date().getTime();
      let requestNumber = 0;
      let durations = [];
      while (new Date().getTime() - startTime <= duration) {
        const scriptStartTime = new Date().getTime();
        for (const test of tests) {
          requestNumber++;
          loggerRequest.info(
            `User #${userNumber} ${userid} - Request ${requestNumber} - Test ${test.name}: before action`
          );
          const commandStartTime = new Date().getTime();
          let response;
          try {
            response = await test.action(); // eslint-disable-line no-await-in-loop
          } catch (e) {
            logger.warn(e);
            response = {
              success: false,
              exception: e,
            };
          }
          const commandEndTime = new Date().getTime();
          const duration = commandEndTime - commandStartTime;
          const responseString = JSON.stringify(response);
          durations.push({
            success: response.success,
            duration: duration,
            userNumber: userNumber,
            testName: test.name,
            requestNumber: requestNumber,
          } as Duration);
          if (response.success) {
            successfulRequests++;
            loggerRequest.info(
              `User #${userNumber} ${userid} - Request ${requestNumber} - Test ${test.name} successful in ${duration} ms: ${responseString}`
            );
          } else {
            failedRequests++;
            loggerRequest.error(
              `User #${userNumber} ${userid} - Request ${requestNumber} - Test ${test.name} failed in ${duration} ms: ${responseString}`
            );
          }

          await sleep(
            Math.max(
              commandDelay - (new Date().getTime() - commandStartTime),
              0
            )
          ); // eslint-disable-line no-await-in-loop
        }

        await sleep(
          Math.max(scriptDelay - (new Date().getTime() - scriptStartTime), 0)
        ); // eslint-disable-line no-await-in-loop
      }

      this.log(
        `Finished tests for ${userNumber} - ${userid} - successful: ${successfulRequests}, failed: ${failedRequests}`
      );
      await this.cleanupTestData(
        session,
        userNumber,
        testJobname,
        testJobid,
        testDsn,
        testUploadUssPath,
        tmpCobolPath
      );

      return {
        failedRequests: failedRequests,
        successfulRequests: successfulRequests,
        durations: durations,
      };
    } catch (e) {
      logger.error(`Error processing tests for ${userNumber} - ${userid}`);
      return {
        failedRequests: 0,
        successfulRequests: 0,
        durations: [],
      };
    }
  }

  private async cleanupTestData(
    session: Session,
    userNumber: number,
    testJobname: string,
    testJobid: string,
    testDsn: string,
    testUploadUssPath: string,
    tmpCobolPath: string
  ) {
    try {
      this.log(`Cleaning up test data for user #${userNumber}`);
      await DeleteJobs.deleteJob(session, testJobname, testJobid);
      await Delete.dataSet(session, testDsn);
      await Delete.ussFile(session, testUploadUssPath);
      unlinkSync(tmpCobolPath);
    } catch (e) {
      logger.error(`Error on cleaning up test data for user #${userNumber}`);
    }
  }

  log(message: string): void {
    logger.info(message);
  }

  async run() {
    try {
      const { args, flags } = this.parse(Zztop);

      await initializeImperative();

      configure({
        appenders: {
          out: { type: "stdout" },
          log: { type: "file", filename: "zztop.log" },
        },
        categories: {
          default: { appenders: ["log"], level: flags.logLevel },
          zztop: { appenders: ["log", "out"], level: flags.logLevel },
          zztopRequest: { appenders: ["log"], level: flags.logLevel },
        },
      });

      console.log = function () {
        logger.warn("console.log", arguments);
      };

      this.log(
        `All logs are written to 'zztop.log' file. Console contains only a subset of messages. Log level is: ${flags.logLevel}`
      );
      this.log(`zztop version: ${this.config.version}`);
      this.log(`Node.js version: ${process.version}`);
      this.log("Zowe version:");
      execSync("zowe --version", { stdio: "inherit" });

      Error.stackTraceLimit = 100;

      this.log(`Test definition file: ${args.file}`);
      if (!existsSync(args.file)) {
        this.error(`File ${resolve(args.file)} does not exist`);
      }

      const testDefinition: TestDefinition = JSON.parse(
        readFileSync(args.file, "utf8")
      );
      this.log(`${JSON.stringify(testDefinition, null, 2)}`);

      const profiles = await new CliProfileManager({
        profileRootDirectory: join(
          ImperativeConfig.instance.cliHome,
          "profiles"
        ),
        type: "zosmf",
      }).loadAll();

      const zosmfProfiles = profiles.filter((profile) => {
        return profile.type === "zosmf";
      });

      const zosmfProfilesByName: { [name: string]: IProfileLoaded } = {};

      for (const profile of zosmfProfiles) {
        if (profile.name) {
          zosmfProfilesByName[profile.name] = profile;
        }
      }

      const promises: Promise<ActivityStats>[] = [];
      for (let i = 0; i < testDefinition.concurrentUsers; i++) {
        promises.push(
          this.userActivity(i, testDefinition, zosmfProfilesByName)
        );
      }

      const allActivityStats = await Promise.all(promises);
      const totalActivityStats = { successfulRequests: 0, failedRequests: 0 };

      const successfulCount: { [name: string]: number } = {};
      const failedCount: { [name: string]: number } = {};
      const successfulDuration: { [name: string]: number } = {};
      const failedDuration: { [name: string]: number } = {};
      for (const testName of testNames) {
        successfulCount[testName] = 0;
        failedCount[testName] = 0;
        successfulDuration[testName] = 0;
        failedDuration[testName] = 0;
      }
      successfulCount["TOTAL"] = 0;
      failedCount["TOTAL"] = 0;
      successfulDuration["TOTAL"] = 0;
      failedDuration["TOTAL"] = 0;

      for (const stats of allActivityStats) {
        totalActivityStats.successfulRequests += stats.successfulRequests;
        totalActivityStats.failedRequests += stats.failedRequests;

        for (const duration of stats.durations) {
          if (duration.success) {
            successfulCount[duration.testName]++;
            successfulDuration[duration.testName] += duration.duration;
            successfulCount["TOTAL"]++;
            successfulDuration["TOTAL"] += duration.duration;
          } else {
            failedCount[duration.testName]++;
            failedDuration[duration.testName] += duration.duration;
            failedCount["TOTAL"]++;
            failedDuration["TOTAL"] += duration.duration;
          }
        }
      }

      const testNamesPlusTotal = [...testNames, "TOTAL"];
      for (const testName of testNamesPlusTotal) {
        this.log(
          `Test ${testName} stats: successful ${successfulCount[testName]}, failed ${failedCount[testName]}` +
            `, average successful duration: ${
              successfulDuration[testName] / successfulCount[testName]
            }` +
            `, average failed duration: ${
              failedDuration[testName] / failedCount[testName]
            }`
        );
      }
    } catch (e) {
      logger.fatal("Unhandled error", e);
    }
  }

  private async prepareTestData(
    testDefinition: TestDefinition,
    userid: string,
    userNumber: number,
    session: Session
  ) {
    if (userNumber == 0) {
      this.log(`Checking directory for USS actions: ${testDefinition.unixDir}`);
      if (!(await Upload.isDirectoryExist(session, testDefinition.unixDir))) {
        this.log(
          `Creating directory for USS actions: ${testDefinition.unixDir}`
        );
        await Create.uss(session, testDefinition.unixDir, "directory");
      }
      const zosfmInfo = await CheckStatus.getZosmfInfo(session);
      this.log("z/OSMF information: " + JSON.stringify(zosfmInfo, null, 2));
    }
    const tmpCobolPath = await this.prepareTestFile(testDefinition);
    const testDsn = await this.prepareTestDataset(
      userid,
      testDefinition,
      userNumber,
      session
    );
    const testUploadUssPath = `${testDefinition.unixDir}/test${userNumber}_${userid}.txt`;
    const {
      testJcl,
      testJobid,
      testJobname,
      testSpoolId,
    } = await this.prepareTestJob(testDefinition, userNumber, session);
    this.log(
      "Prepared test data: " +
        JSON.stringify([
          userNumber,
          "-",
          tmpCobolPath,
          testDsn,
          testJobname,
          testJobid,
          testSpoolId,
          testUploadUssPath,
        ])
    );
    return {
      tmpCobolPath,
      testDsn,
      testJobname,
      testJobid,
      testSpoolId,
      testJcl,
      testUploadUssPath,
    };
  }

  private async prepareTestFile(testDefinition: TestDefinition) {
    const tmpCobolPath = tmp.tmpNameSync();
    const lineCount = filesizeParser(testDefinition.memberSize) / 80;
    const result = " 04110     DISPLAY 'HELLO, WORLD' UPON CONSL.                           00170000\n".repeat(
      lineCount
    );
    await promises.writeFile(tmpCobolPath, result);
    return tmpCobolPath;
  }

  private async prepareTestDataset(
    userid: string,
    testDefinition: TestDefinition,
    userNumber: number,
    session: Session
  ) {
    const testDsn =
      userid.toUpperCase() +
      "." +
      testDefinition.dsnSecondSegment +
      `.U${userNumber}`;
    this.log(`Preparing test dataset: ${testDsn}`);
    const exists = await datasetExists(session, testDsn);
    if (!exists) {
      const response = await Create.dataSet(
        session,
        CreateDataSetTypeEnum.DATA_SET_CLASSIC,
        testDsn
      );
      if (!response.success) {
        logger.error(response.commandResponse);
        throw Error(`Error preparing test dataset: ${testDsn}`);
      }
    }
    return testDsn;
  }

  private async prepareTestJob(
    testDefinition: TestDefinition,
    userNumber: number,
    session: Session
  ) {
    const jobCard = testDefinition.jobCard
      .join("\n")
      .replace("$jobname", `ZZT${userNumber}`);
    const jobLines = [
      "//RUN EXEC PGM=IEBGENER",
      "//SYSPRINT DD SYSOUT=*",
      "//SYSIN DD DUMMY",
      "//SYSUT2 DD SYSOUT=*",
      "//SYSUT1 DD *",
    ];
    const sysut1LineCount = filesizeParser(testDefinition.jobOutputSize) / 80;
    const testJcl =
      jobCard +
      "\n" +
      jobLines.join("\n") +
      "\n" +
      " 04110     DISPLAY 'HELLO, WORLD' UPON CONSL.                           00170000\n".repeat(
        sysut1LineCount
      );
    const job = await SubmitJobs.submitJclNotifyCommon(session, {
      jcl: testJcl,
    });
    if (job.retcode !== "CC 0000") {
      this.error(JSON.stringify(job), { exit: 2 });
    }
    const testJobid = job.jobid;
    const testJobname = job.jobname;

    const jobFiles = await GetJobs.getSpoolFiles(
      session,
      testJobname,
      testJobid
    );
    let testSpoolId = 0;
    for (const jobFile of jobFiles) {
      if (jobFile.ddname === "SYSUT2") {
        testSpoolId = jobFile.id;
      }
    }
    return { testJcl, testJobid, testJobname, testSpoolId };
  }
}

export = Zztop;
