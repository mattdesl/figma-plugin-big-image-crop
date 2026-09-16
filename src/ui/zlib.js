// zlib.js — zlib (de)compression via the platform's streams, no dependency. PNG IDAT and iCCP both
// use raw zlib, which is exactly what CompressionStream/DecompressionStream("deflate") produce and
// accept.

async function pipe(bytes, stream) {
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

export const deflate = (bytes) => pipe(bytes, new CompressionStream("deflate"));
export const inflate = (bytes) =>
  pipe(bytes, new DecompressionStream("deflate"));
