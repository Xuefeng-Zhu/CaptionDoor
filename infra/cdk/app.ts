#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { CaptionDoorStack } from "./stack";
const app = new App();
new CaptionDoorStack(app, "CaptionDoor", {
  description:
    "CaptionDoor private single-region persistence, jobs, auth and runtime permissions; synth only until deployment is explicitly authorized",
});
app.synth();
