import { createEmulator } from "../../src/emulator.ts";
const e = await createEmulator({ romDir: "/tmp/never" });
console.log("boot OK");
e.destroy();
