// Probe: can a deno-compiled binary read a file embedded via --include?
const u = new URL('./dist/gui-assets/transcriber.worker.mjs', import.meta.url);
try {
  const b = await Deno.readFile(u);
  console.log('PROBE_OK bytes=' + b.length + ' url=' + u.href);
} catch (e) {
  console.log('PROBE_FAIL ' + (e as Error).message + ' url=' + u.href);
}
