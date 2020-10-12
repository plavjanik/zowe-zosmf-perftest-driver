import { test } from "@oclif/test";

import cmd = require("../src");

describe("zztop", () => {
  test
    .stdout()
    .do(() => cmd.run([]))
    .exit(2)
    .it("fails without arguments");

  test
    .stdout()
    .do(() => cmd.run(["test/bad.json"]))
    .exit(2)
    .it("fails with missing test def file");
});
