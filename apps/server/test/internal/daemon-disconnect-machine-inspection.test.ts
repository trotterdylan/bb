import { getHost, getThread, listEvents, updateHost } from "@bb/db";
import { systemThreadInterruptedEventDataSchema } from "@bb/domain";
import type { PluginMachineProviderInspection } from "@get-bb/plugin-sdk/machine-provider";
import { validatePluginMachineProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS } from "../../src/constants.js";
import { handleDaemonSocketClosed } from "../../src/internal/session-owner-side-effects.js";
import { setPluginMachineProviderBridge } from "../../src/services/plugins/plugin-machine-provider-registry.js";
import { advanceUntilTrue } from "../helpers/fake-timers.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const EXITED: PluginMachineProviderInspection = {
  status: "exited",
  reason: "OOMKilled",
  detail: "exit code 137",
  exitedAt: 1_700_000_000_000,
};

function installMachineProvider(
  harness: TestAppHarness,
  hostId: string,
  inspect: (() => Promise<PluginMachineProviderInspection>) | undefined,
) {
  const record = {
    pluginId: "test-machine",
    provider: validatePluginMachineProviderDeclaration({
      description: "Provision a test machine.",
      icon: "Terminal",
      id: "test-machine",
      displayName: "Test machine",
      reconcileCleanup: async () => ({ status: "removed" }),
      create: async () => ({
        status: "created",
        name: "Test machine",
        hostId,
        resource: { id: "owned" },
      }),
      ...(inspect === undefined ? {} : { inspect }),
      remove: async () => ({ status: "removed" }),
    }),
  };
  setPluginMachineProviderBridge({
    listMachineProviders: () => [record],
    getMachineProvider: () => record,
    invokeProvider: async (_pluginId, _label, run) => {
      try {
        return { ok: true, value: await run() };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
    decisionTimeoutMs: 10_000,
  });
  updateHost(harness.db, harness.hub, hostId, {
    machineProviderId: "test-machine",
    resource: { id: "owned" },
  });
}

function seedActiveThreadOnHost(harness: TestAppHarness, hostId: string) {
  const { project } = seedProjectWithSource(harness.deps, { hostId });
  const environment = seedEnvironment(harness.deps, {
    hostId,
    projectId: project.id,
    path: "/tmp/machine-inspection",
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: "active",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: "provider-session",
    threadId: thread.id,
  });
  return thread;
}

async function loseDaemonUntilInterrupted(
  harness: TestAppHarness,
  args: { sessionId: string; threadId: string },
): Promise<void> {
  vi.useFakeTimers();
  try {
    handleDaemonSocketClosed(harness.deps, { sessionId: args.sessionId });
    await advanceUntilTrue(
      () => getThread(harness.db, args.threadId)?.status === "error",
      DAEMON_ACTIVE_WORK_DISCONNECT_GRACE_MS,
    );
  } finally {
    vi.useRealTimers();
  }
}

function interruptionRecord(harness: TestAppHarness, threadId: string) {
  const rows = listEvents(harness.db, { threadId });
  const interrupted = rows.findLast(
    (row) => row.type === "system/thread/interrupted",
  );
  const failure = rows.findLast((row) => row.type === "system/error");
  if (interrupted === undefined || failure === undefined) {
    throw new Error("expected the interruption events");
  }
  return {
    interrupted: systemThreadInterruptedEventDataSchema.parse(
      JSON.parse(interrupted.data),
    ),
    failure: JSON.parse(failure.data) as { detail?: string },
  };
}

afterEach(() => {
  setPluginMachineProviderBridge(undefined);
  vi.useRealTimers();
});

describe("machine inspection after a daemon disconnect", () => {
  it("records what the provider saw on the interruption, the failure, and the host", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-inspect-exited",
      });
      const inspect = vi.fn(async () => EXITED);
      installMachineProvider(harness, host.id, inspect);
      const thread = seedActiveThreadOnHost(harness, host.id);

      await loseDaemonUntilInterrupted(harness, {
        sessionId: session.id,
        threadId: thread.id,
      });

      expect(inspect).toHaveBeenCalledTimes(1);
      expect(inspect.mock.calls[0]?.[0]).toMatchObject({
        hostId: host.id,
        resource: { id: "owned" },
      });
      const { interrupted, failure } = interruptionRecord(harness, thread.id);
      expect(interrupted).toEqual({
        reason: "host-daemon-restarted",
        cause: "host-connection-lost",
        machine: EXITED,
      });
      expect(failure.detail).toBe(
        "The machine reported that its compute exited: OOMKilled (exit code 137). Suspend and resume the machine, then retry the thread.",
      );
      expect(getHost(harness.db, host.id)?.statusMessage).toBe(
        "Machine stopped: OOMKilled (exit code 137). Suspend and resume it to start it again.",
      );
    });
  });

  it("leaves the interruption unchanged when the provider says compute is running", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-inspect-running",
      });
      installMachineProvider(harness, host.id, async () => ({
        status: "running",
      }));
      const thread = seedActiveThreadOnHost(harness, host.id);

      await loseDaemonUntilInterrupted(harness, {
        sessionId: session.id,
        threadId: thread.id,
      });

      const { interrupted, failure } = interruptionRecord(harness, thread.id);
      expect(interrupted).toEqual({
        reason: "host-daemon-restarted",
        cause: "host-connection-lost",
      });
      expect(failure.detail).toBe("Please retry the thread to continue.");
      expect(getHost(harness.db, host.id)?.statusMessage).toBeNull();
    });
  });

  it("still interrupts when inspect fails or is not declared", async () => {
    await withTestHarness(async (harness) => {
      const failing = seedHostSession(harness.deps, {
        id: "host-inspect-failing",
      });
      installMachineProvider(harness, failing.host.id, async () => {
        throw new Error("kube api unreachable");
      });
      const failingThread = seedActiveThreadOnHost(harness, failing.host.id);
      await loseDaemonUntilInterrupted(harness, {
        sessionId: failing.session.id,
        threadId: failingThread.id,
      });
      expect(
        interruptionRecord(harness, failingThread.id).interrupted.machine,
      ).toBeUndefined();

      const silent = seedHostSession(harness.deps, {
        id: "host-inspect-undeclared",
      });
      installMachineProvider(harness, silent.host.id, undefined);
      const silentThread = seedActiveThreadOnHost(harness, silent.host.id);
      await loseDaemonUntilInterrupted(harness, {
        sessionId: silent.session.id,
        threadId: silentThread.id,
      });
      expect(
        interruptionRecord(harness, silentThread.id).interrupted.machine,
      ).toBeUndefined();
    });
  });
});
