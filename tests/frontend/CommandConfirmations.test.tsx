import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  t: (key: string) => key,
}));
vi.mock("../../src/frontend/app-ref", () => ({
  aiApp: () => ({ api: mocks }),
}));
vi.mock("@termix-ssh/plugin-sdk/frontend", async (original) => ({
  ...(await original<object>()),
  useTranslation: () => ({ t: mocks.t }),
}));
import { CommandConfirmations } from "../../src/frontend/assistant/CommandConfirmations";
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({
    data: {
      confirmations: [
        {
          id: 7,
          command: "reboot",
          hostIds: [1],
          hosts: [{ id: 1, name: "web-1" }],
          reason: "Kernel update",
          risk: "Availability",
          expiresAt: Date.now() + 86400000,
        },
      ],
    },
  });
  mocks.post.mockResolvedValue({ data: { ok: true } });
});
it.each([
  [true, "confirmations.approve"],
  [false, "confirmations.reject"],
])(
  "submits only the decision for the frozen request (%s)",
  async (approved, label) => {
    render(<CommandConfirmations />);
    expect(await screen.findByText("reboot")).toBeTruthy();
    expect(screen.getByText(/web-1/)).toBeTruthy();
    fireEvent.click(screen.getByText(String(label)));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith("/confirmations/7/decision", {
        approved,
      }),
    );
    await waitFor(() => expect(screen.queryByText("reboot")).toBeNull());
  },
);
it("keeps the command visible when the decision request fails", async () => {
  mocks.post.mockRejectedValue(new Error("offline"));
  render(<CommandConfirmations />);
  await screen.findByText("reboot");
  fireEvent.click(screen.getByText("confirmations.approve"));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "confirmations.decisionFailed",
  );
  expect(screen.getByText("reboot")).toBeTruthy();
});
