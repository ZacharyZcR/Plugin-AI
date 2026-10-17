import { afterEach, describe, expect, it } from "vitest";
import { startServer, type TestServer } from "../helpers";
import { fakeSshClient } from "../ops/fake-ssh";
import { insertTask, OPS_PERMISSIONS } from "./fixtures";
let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});
describe("retired plan approval", () => {
  it("never executes an old plan through the legacy approval endpoint", async () => {
    const ssh = fakeSshClient(() => ({ stdout: "ok" }));
    server = await startServer({
      permissions: OPS_PERMISSIONS,
      sshClient: ssh.client,
    });
    await server.enableFor("user-1");
    const id = insertTask(server, {
      plan: JSON.stringify([{ hostId: 1, commands: ["reboot"] }]),
    });
    const response = await server.request("POST", `/tasks/${id}/approve`);
    expect(response.status).toBe(410);
    expect(ssh.channels).toHaveLength(0);
  });
});
