// Ambient declarations for the document parsers that ship no type definitions.
//
// These are lazy-loaded through a LITERAL `import('<name>')` (see `loadParser`)
// so the packaged desktop app's static bundler discovers and includes them —
// a runtime *variable* specifier is invisible to that bundler, which silently
// dropped every document parser from the app and made dragged Office documents
// extract nothing. A literal specifier must resolve at type-check time under
// `strict`, so the untyped ones are declared here as `any`. (`unpdf` and
// `fflate` ship their own types and need no declaration.)
declare module 'mammoth';
declare module 'word-extractor';
