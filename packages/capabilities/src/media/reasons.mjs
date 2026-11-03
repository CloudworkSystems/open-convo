// Plain sentences the owner can read. The command and the library both use
// these, so a refusal and the report say the same thing.

export const REASONS = {
  record: 'This capability record does not check out.',
  routeMissing: 'That route is not on this capability.',
  routeKind: 'That route is not an upload or a local run.',
  notAvailable: 'That route is not available yet.',
  localSetup: 'Set up the local model first.',
  fileType: 'That file is not a type this capability accepts.',
  fileSize: 'That file is over the size limit.',
  fileUnreadable: 'That file could not be read.',
  fileLink: 'That file is a link, so it was not copied.',
  noFileRule: "This capability doesn't say which files it accepts.",
  madeHow: 'Say how the file was made: filmed or drawn by you, made with AI, or not sure.',
  mediaFolder: 'The media folder is missing.',
  mediaLink: 'The media folder has to be a real folder on this Mac.',
  notSaved: 'The file could not be saved.',
  serverAddress: 'The local server has to be on this Mac, at 127.0.0.1 or ::1.',
  redirect: 'ComfyUI sent a redirect, so the run stopped before anything else was sent.',
  notRunning: "ComfyUI isn't running on this Mac. Open ComfyUI and leave it running, then try again.",
  noAnswer: 'ComfyUI did not answer. Nothing was sent again.',
  stoppedServer: 'ComfyUI stopped while this was running. Nothing was sent again.',
  stopped: 'The local run was stopped.',
  workflow: 'The workflow does not check out.',
  workflowKind: 'This workflow makes a different kind than you asked for.',
  workflowPrompt: 'The workflow needs exactly one {{prompt}} field.',
  workflowValue: 'The workflow needs exactly one place for each value you set, and no empty placeholder.',
  badRequest: 'That request does not check out.',
  comfyFailed: 'ComfyUI could not make the file. Nothing was sent again.',
  noOutput: 'ComfyUI finished without an image or a video. Nothing was sent again.',
  tooBig: 'The file from ComfyUI was over the size limit, so it was not saved.',
  badTime: 'The time does not check out.',
  unexpected: 'The run stopped because something unexpected went wrong. Nothing was sent again.',
};

export function refusedNode(classType) {
  const name = typeof classType === 'string' && /^[A-Za-z0-9_ .:/-]{1,80}$/.test(classType)
    ? classType
    : 'one this Mac does not know';
  return `This workflow uses a node this Mac will not run (${name}).`;
}
