// Process-group cleanup shared by the check runner and the queueing lock: a
// command is not finished while any member of the group it was started in is
// still running. Only the group a caller owns is ever signalled.
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function groupAlive(group) {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // A sandbox can refuse the signal-0 probe after the group leader exits;
    // the group still exists and must not be treated as cleaned up.
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForGroupExit(group, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (groupAlive(group) && Date.now() < deadline) await wait(20);
  return !groupAlive(group);
}

/** TERM the group, wait graceMs, then KILL it; throws if it survives KILL. */
export async function terminateGroup(group, graceMs) {
  if (!group || !groupAlive(group)) return;
  try {
    process.kill(-group, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  if (await waitForGroupExit(group, graceMs)) return;
  try {
    process.kill(-group, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  if (!(await waitForGroupExit(group, graceMs)))
    throw new Error(`process group ${group} did not exit after SIGKILL`);
}
