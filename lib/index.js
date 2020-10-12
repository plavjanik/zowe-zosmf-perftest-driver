"use strict";
const command_1 = require("@oclif/command");
const fs_1 = require("fs");
const path_1 = require("path");
const tmp = require("tmp");
const imperative_1 = require("@zowe/imperative");
const cli_1 = require("@zowe/cli");
const perf_timing_1 = require("@zowe/perf-timing");
const parse_duration_1 = require("parse-duration");
const filesizeParser = require("filesize-parser");
async function initializeImperative() {
  const mainZoweDir = path_1.join(
    require.resolve("@zowe/cli"),
    "..",
    "..",
    "..",
    ".."
  );
  process.mainModule.filename = require.resolve("@zowe/cli");
  process.mainModule.paths.unshift(mainZoweDir);
  await imperative_1.Imperative.init({
    configurationModule: require.resolve("@zowe/cli/lib/imperative.js"),
  });
}
async function datasetExists(session, dsn) {
  const response = await cli_1.List.dataSet(session, dsn);
  try {
    return response.apiResponse.returnedRows === 1;
  } catch (error) {
    return false;
  }
}
class Zztop extends command_1.Command {
  async userActivity(userNumber, testDefinition, zosmfProfilesByName) {
    const scriptDelay =
      parse_duration_1.default(testDefinition.scriptDelay) || 1000;
    const commandDelay =
      parse_duration_1.default(testDefinition.commandDelay) || 1000;
    const duration = parse_duration_1.default(testDefinition.duration) || 1000;
    await cli_1.sleep(scriptDelay * userNumber);
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
    const session = cli_1.ZosmfSession.createBasicZosmfSession(profile.profile);
    const tmpCobolPath = tmp.tmpNameSync();
    const lineCount = filesizeParser(testDefinition.memberSize) / 80;
    const result = " 04110     DISPLAY 'HELLO, WORLD' UPON CONSL.                           00170000\n".repeat(
      lineCount
    );
    await fs_1.promises.writeFile(tmpCobolPath, result);
    const testDsn =
      userid.toUpperCase() +
      "." +
      testDefinition.dsnSecondSegment +
      `.U${userNumber}`;
    this.log(testDsn);
    const exists = await datasetExists(session, testDsn);
    if (!exists) {
      const response = await cli_1.Create.dataSet(
        session,
        2 /* DATA_SET_CLASSIC */,
        testDsn
      );
      if (!response.success) {
        this.error(response.commandResponse, { exit: 2 });
      }
    }
    let successfulRequests = 0;
    let failedRequests = 0;
    const startTime = new Date().getTime();
    while (new Date().getTime() - startTime <= duration) {
      const scriptStartTime = new Date().getTime();
      const commandStartTime = new Date().getTime();
      perf_timing_1.PerfTiming.api.mark("BeforeDatasetUpload");
      const uploadResponse = await cli_1.Upload.fileToDataset(
        session,
        tmpCobolPath,
        testDsn + "(TEST1)"
      ); // eslint-disable-line no-await-in-loop
      perf_timing_1.PerfTiming.api.mark("AfterDatasetUpload");
      perf_timing_1.PerfTiming.api.measure(
        "DatasetUpload",
        "BeforeDatasetUpload",
        "AfterDatasetUpload"
      );
      this.log(JSON.stringify(uploadResponse));
      if (uploadResponse.success) {
        successfulRequests++;
      } else {
        failedRequests++;
      }
      await cli_1.sleep(
        Math.max(commandDelay - (new Date().getTime() - commandStartTime), 0)
      ); // eslint-disable-line no-await-in-loop
      await cli_1.sleep(
        Math.max(scriptDelay - (new Date().getTime() - scriptStartTime), 0)
      ); // eslint-disable-line no-await-in-loop
    }
    return {
      failedRequests: failedRequests,
      successfulRequests: successfulRequests,
    };
  }
  async run() {
    const { args } = this.parse(Zztop);
    this.log(`Test definition file: ${args.file}`);
    if (!fs_1.existsSync(args.file)) {
      this.error(`File ${path_1.resolve(args.file)} does not exist`);
    }
    if (!perf_timing_1.PerfTiming.isEnabled) {
      this.error(
        "PerfTiming is not enabled. Set environment variables: PERF_TIMING_ENABLED=TRUE PERF_TIMING_IO_MAX_HISTORY=1 PERF_TIMING_IO_SAVE_DIR=.",
        { exit: 1 }
      );
    }
    const testDefinition = JSON.parse(fs_1.readFileSync(args.file, "utf8"));
    this.log(`${JSON.stringify(testDefinition, null, 2)}`);
    await initializeImperative();
    const profiles = await new imperative_1.CliProfileManager({
      profileRootDirectory: path_1.join(
        imperative_1.ImperativeConfig.instance.cliHome,
        "profiles"
      ),
      type: "zosmf",
    }).loadAll();
    const zosmfProfiles = profiles.filter((profile) => {
      return profile.type === "zosmf";
    });
    const zosmfProfilesByName = {};
    for (const profile of zosmfProfiles) {
      if (profile.name) {
        zosmfProfilesByName[profile.name] = profile;
      }
    }
    const promises = [];
    for (let i = 0; i < testDefinition.concurrentUsers; i++) {
      promises.push(this.userActivity(i, testDefinition, zosmfProfilesByName));
    }
    const allActivityStats = await Promise.all(promises);
    const totalActivityStats = { successfulRequests: 0, failedRequests: 0 };
    for (const stats of allActivityStats) {
      totalActivityStats.successfulRequests += stats.successfulRequests;
      totalActivityStats.failedRequests += stats.failedRequests;
    }
    await cli_1.sleep(1000);
    for (const measurement of perf_timing_1.PerfTiming.api.getMetrics()
      .measurements) {
      if (measurement.name === "DatasetUpload") {
        this.log(`Average DatasetUpload: ${measurement.averageDuration} ms`);
      }
    }
    this.log("Total activity count", JSON.stringify(totalActivityStats));
  }
}
Zztop.description = "describe the command here";
Zztop.flags = {
  // add --version flag to show CLI version
  version: command_1.flags.version({ char: "v" }),
  help: command_1.flags.help({ char: "h" }),
};
Zztop.args = [
  { name: "file", required: true, description: "Test definition file" },
];
module.exports = Zztop;
