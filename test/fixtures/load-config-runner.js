// Tiny runner so tests can exercise loadConfig()'s process.exit(1) behavior
// as a real subprocess, without killing the test runner itself.
import { loadConfig } from "../../src/config.js";

loadConfig(process.argv[2]);
console.log("loaded ok");
