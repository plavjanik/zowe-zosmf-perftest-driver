import { Command, flags } from "@oclif/command";
import { existsSync, promises, readFileSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import * as tmp from "tmp";
import {
  AbstractSession,
  CliProfileManager,
  Imperative,
  ImperativeConfig,
  IProfileLoaded,
  Session,
  Logger,
  LoggingConfigurer,
} from "@zowe/imperative";
import {
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
import { PerfTiming } from "@zowe/perf-timing";
import parse from "parse-duration";

const filesizeParser = require("filesize-parser");
const winston = require("winston");

const logger = winston.createLogger({
  level: "info",
  format: winston.format.json(),
  defaultMeta: { service: "user-service" },
  transports: [
    new winston.transports.File({
      filename: "requests-error.log",
      level: "error",
    }),
    new winston.transports.File({ filename: "requests.log" }),
  ],
});

interface TestDefinition {
  name: string;
  fileSize: string;
  memberSize: string;
  jobOutputSize: string;
  duration: string;
  commandDelay: string;
  scriptDelay: string;
  concurrentUsers: number;
  zosmfProfiles: string[];
  dsnSecondSegment: string;
  unixDir: string;
  accountCode: string;
  jobCard: string[];
}

interface ActivityStats {
  successfulRequests: number;
  failedRequests: number;
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
    const duration = parse(testDefinition.duration) || 1000;
    await sleep(scriptDelay * userNumber);

    const profileName =
      testDefinition.zosmfProfiles[
        userNumber % testDefinition.zosmfProfiles.length
      ];
    const profile = zosmfProfilesByName[profileName];
    if (!profile || !profile.profile) {
      this.error(`Invalid profile name: ${profileName}`);
      return { failedRequests: 0, successfulRequests: 0 };
    }

    const userid = profile.profile.user;
    this.log(`Userid #${userNumber}: ${userid}`);
    const session = ZosmfSession.createBasicZosmfSession(profile.profile);

    const {
      tmpCobolPath,
      testDsn,
      testJobname,
      testJobid,
      testSpoolId,
      testJcl,
      testUploadUssPath,
    } = await this.prepareTestData(testDefinition, userid, userNumber, session);

    this.log(`Running tests for ${userNumber} - ${userid}`);

    const tests = [
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
          return Upload.fileToUssFile(session, tmpCobolPath, testUploadUssPath);
        },
      },
      // zowe files download uf
      {
        name: "FileDownload",
        action: async function () {
          const tmpDownloadPath = tmp.tmpNameSync();
          const response = await Download.ussFile(
            session,
            `${testDefinition.unixDir}/test${userNumber}.txt`,
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
          try {
            const response = await IssueTso.issueTsoCommand(
              session,
              testDefinition.accountCode,
              `SEND 'Hello' USER(${userid})`
            );
            return response;
          } catch (error) {
            return { success: false, error: error };
          }
        },
      },
      // zowe console issue command
      {
        name: "ConsoleCommand",
        action: async function () {
          return IssueCommand.issue(session, { command: "D IPLINFO" });
        },
      },
      // zowe jobs submit [PP]
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
      // zowe jobs view [PP]
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
      // zowe jobs download [PP]
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

    let successfulRequests = 0;
    let failedRequests = 0;
    const startTime = new Date().getTime();
    let requestNumber = 0;
    while (new Date().getTime() - startTime <= duration) {
      const scriptStartTime = new Date().getTime();
      PerfTiming.api.mark("BeforeScript" + userNumber);

      for (const test of tests) {
        requestNumber++;
        const commandStartTime = new Date().getTime();
        PerfTiming.api.mark("Before" + test.name + userNumber);
        let response;
        try {
          response = await test.action(); // eslint-disable-line no-await-in-loop
        } catch (e) {
          response = {
            success: false,
            exception: e,
          };
        }
        PerfTiming.api.mark("After" + test.name + userNumber);
        const responseString = JSON.stringify(response);
        if (response.success) {
          PerfTiming.api.measure(
            test.name,
            "Before" + test.name + userNumber,
            "After" + test.name + userNumber
          );
          successfulRequests++;
          logger.info(
            `User #${userNumber} ${userid} - Request ${requestNumber} - Test ${test.name}: ${responseString}`
          );
        } else {
          PerfTiming.api.measure(
            test.name + "Failed",
            "Before" + test.name + userNumber,
            "After" + test.name + userNumber
          );
          failedRequests++;
          logger.error(
            `User #${userNumber} ${userid} - Request ${requestNumber} - Test ${test.name}: ${responseString}`
          );
        }

        await sleep(
          Math.max(commandDelay - (new Date().getTime() - commandStartTime), 0)
        ); // eslint-disable-line no-await-in-loop
      }
      PerfTiming.api.mark("AfterScript" + userNumber);
      PerfTiming.api.measure(
        "Script",
        "BeforeScript" + userNumber,
        "AfterScript" + userNumber
      );

      await sleep(
        Math.max(scriptDelay - (new Date().getTime() - scriptStartTime), 0)
      ); // eslint-disable-line no-await-in-loop
    }

    this.log(`Finished tests for ${userNumber} - ${userid}`);
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
    };
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

  async run() {
    const { args } = this.parse(Zztop);

    Logger.initLogger(
      LoggingConfigurer.configureLogger(".zztop", { name: "zztop" })
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

    if (!PerfTiming.isEnabled) {
      this.error(
        "PerfTiming is not enabled. Set environment variables: PERF_TIMING_ENABLED=TRUE PERF_TIMING_IO_MAX_HISTORY=1 PERF_TIMING_IO_SAVE_DIR=.",
        { exit: 1 }
      );
    }

    const testDefinition: TestDefinition = JSON.parse(
      readFileSync(args.file, "utf8")
    );
    this.log(`${JSON.stringify(testDefinition, null, 2)}`);
    await initializeImperative();

    const profiles = await new CliProfileManager({
      profileRootDirectory: join(ImperativeConfig.instance.cliHome, "profiles"),
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
      promises.push(this.userActivity(i, testDefinition, zosmfProfilesByName));
    }

    const allActivityStats = await Promise.all(promises);
    const totalActivityStats = { successfulRequests: 0, failedRequests: 0 };
    for (const stats of allActivityStats) {
      totalActivityStats.successfulRequests += stats.successfulRequests;
      totalActivityStats.failedRequests += stats.failedRequests;
    }

    await sleep(1000);
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
      "Script",
    ];
    for (const measurement of PerfTiming.api.getMetrics().measurements) {
      for (const testName of testNames) {
        if (measurement.name === testName) {
          this.log(
            `Average successful ${testName}: ${measurement.averageDuration} ms`
          );
        }
        if (measurement.name === testName + "Failed") {
          this.log(
            `Average failed ${testName}: ${measurement.averageDuration} ms`
          );
        }
      }
    }
    this.log("Total activity count", JSON.stringify(totalActivityStats));
  }

  private async prepareTestData(
    testDefinition: TestDefinition,
    userid: string,
    userNumber: number,
    session: Session
  ) {
    const tmpCobolPath = await this.prepareTestFile(testDefinition);
    const testDsn = await this.prepareTestDataset(
      userid,
      testDefinition,
      userNumber,
      session
    );
    const testUploadUssPath = `${testDefinition.unixDir}/test${userNumber}.txt`;
    const {
      testJcl,
      testJobid,
      testJobname,
      testSpoolId,
    } = await this.prepareTestJob(testDefinition, userNumber, session);
    this.log(
      "Prepared test data",
      userNumber,
      "-",
      tmpCobolPath,
      testDsn,
      testJobname,
      testJobid,
      testSpoolId,
      testUploadUssPath
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
    this.log(testDsn);
    const exists = await datasetExists(session, testDsn);
    if (!exists) {
      const response = await Create.dataSet(
        session,
        CreateDataSetTypeEnum.DATA_SET_CLASSIC,
        testDsn
      );
      if (!response.success) {
        this.error(response.commandResponse, { exit: 2 });
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
