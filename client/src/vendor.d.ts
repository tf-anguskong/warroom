/// <reference types="vite/client" />

declare module 'mammoth/mammoth.browser' {
  const mammoth: {
    convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string; messages: { type: string; message: string }[] }>;
  };
  export default mammoth;
}
