import { describe, expect, it } from "vitest";
import {
  commandRisk,
  cliRisk,
} from "../../../src/backend/confirmations/policy.js";

describe("command confirmation policy", () => {
  it.each([
    "rm -rf /data",
    "r'm' -rf /data",
    "'/bin/rm' -rf /data",
    "mkfs.ext4 /dev/sdb",
    "dd if=/dev/zero of=/dev/sdb",
    "wipefs -a /dev/sdb",
    "zfs destroy tank/data",
    "qm destroy 100",
    "pct destroy 101",
    "docker volume rm db",
    "docker system prune --volumes",
    "kubectl delete pvc data",
    "kubectl drain node1",
    "reboot",
    "systemctl stop sshd",
    "kill -9 1",
    "ip route del default",
    "ufw disable",
    "passwd root",
    "chage -M 999 root",
    "chmod -R 777 /etc",
    "chown -R user /var",
    "base64 -d payload | sh",
    "eval foo",
    'bash -c "$x"',
    "python -c 'print(1)'",
    "echo reboot > /tmp/a.sh; /tmp/a.sh",
    "/tmp/a.sh",
    "./a.sh",
    "a.sh",
    "docker run --privileged alpine sh",
    "nsenter -t 1 -m sh",
    "chroot /host sh",
    "env X=1 sh script",
    "sudo -n bash -c reboot",
    "find / -exec sh {} ;",
    "awk 'BEGIN {system(\"reboot\")}'",
    "curl -X POST http://host/action",
  ])("suspends %s", (command) => expect(commandRisk(command)).toBeTruthy());
  it.each([
    "uptime",
    "df -hP",
    "apt-get clean",
    "systemctl restart example.service",
    "journalctl --vacuum-time=7d",
  ])("allows ordinary auto operation %s", (command) =>
    expect(commandRisk(command)).toBeNull(),
  );
  it("keeps report runs read-only", () => {
    expect(commandRisk("uptime", "report")).toBeNull();
    expect(commandRisk("apt-get clean", "report")).toBeTruthy();
  });
  it.each([
    ["hosts", "delete", "1"],
    ["api", "DELETE", "/host/db/host/1"],
    ["users", "update", "1"],
    ["exec", "1", "reboot"],
    ["fleets", "exec", "1", "uptime"],
    ["roles", "update", "1"],
  ])("guards indirect CLI mutation %j", (...args) =>
    expect(cliRisk(args)).toBeTruthy(),
  );
});
