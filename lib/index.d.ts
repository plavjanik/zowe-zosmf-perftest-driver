import { Command } from '@oclif/command';
import { IProfileLoaded } from '@zowe/imperative';
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
declare class Zztop extends Command {
    static description: string;
    static flags: {
        version: import("@oclif/parser/lib/flags").IBooleanFlag<void>;
        help: import("@oclif/parser/lib/flags").IBooleanFlag<void>;
    };
    static args: {
        name: string;
        required: boolean;
        description: string;
    }[];
    userActivity(userNumber: number, testDefinition: TestDefinition, zosmfProfilesByName: {
        [name: string]: IProfileLoaded;
    }): Promise<ActivityStats>;
    run(): Promise<void>;
}
export = Zztop;
