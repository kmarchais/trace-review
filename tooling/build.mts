import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.join(root, "dist", "runtime");

fs.rmSync(runtimeRoot, { recursive: true, force: true });

for (const relativePath of ["schemas/review-spec.v1.schema.json"]) {
  const source = path.join(root, relativePath);
  const destination = path.join(runtimeRoot, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

const clientBuild = await Bun.build({
  entrypoints: [path.join(root, "src", "review-client.ts")],
  target: "browser",
  format: "iife",
  minify: false,
});
if (!clientBuild.success) {
  throw new AggregateError(clientBuild.logs, "Could not bundle the review client.");
}
const clientOutput = clientBuild.outputs[0];
if (!clientOutput) throw new Error("The browser build did not produce an output.");
const clientScript = await clientOutput.text();
const templateSource = fs.readFileSync(
  path.join(root, "templates", "review.template.html"),
  "utf8",
);
if (!templateSource.includes("{{CLIENT_SCRIPT}}")) {
  throw new Error("The review template is missing the client-script placeholder.");
}
const templateDestination = path.join(runtimeRoot, "templates", "review.template.html");
fs.mkdirSync(path.dirname(templateDestination), { recursive: true });
fs.writeFileSync(
  templateDestination,
  templateSource.replace("{{CLIENT_SCRIPT}}", clientScript),
  "utf8",
);

console.log(`Built Node-compatible runtime in ${runtimeRoot}`);
