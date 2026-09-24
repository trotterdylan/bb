import { getHost, updateHost } from "@bb/db";
import type { SystemThreadInterruptedMachine } from "@bb/domain";
import { z } from "zod";
import type { AppDeps } from "../../types.js";
import {
  getMachineProvider,
  invokeMachineProvider,
} from "../plugins/plugin-machine-provider-registry.js";

export const MACHINE_INSPECT_TIMEOUT_MS = 5_000;

const inspectionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("running") }),
  z.object({
    status: z.literal("exited"),
    reason: z.string().trim().min(1),
    detail: z.string().trim().min(1).optional(),
    exitedAt: z.number().optional(),
  }),
]);

type MachineInspectionDeps = Pick<AppDeps, "db" | "hub" | "logger">;

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("machine inspect timed out"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

export function machineExitStatusMessage(
  machine: SystemThreadInterruptedMachine,
): string {
  const detail = machine.detail === undefined ? "" : ` (${machine.detail})`;
  return `Machine stopped: ${machine.reason}${detail}. Suspend and resume it to start it again.`;
}

export async function inspectDisconnectedMachine(
  deps: MachineInspectionDeps,
  hostId: string,
): Promise<SystemThreadInterruptedMachine | null> {
  const row = getHost(deps.db, hostId);
  if (
    row === null ||
    row.machineProviderId === null ||
    row.resource === null ||
    row.phase !== "active"
  ) {
    return null;
  }
  const record = getMachineProvider(row.machineProviderId);
  const inspect = record?.provider.inspect ?? null;
  if (record === undefined || inspect === null) return null;
  const resource = row.resource;
  const signal = AbortSignal.timeout(MACHINE_INSPECT_TIMEOUT_MS);
  const invocation = await invokeMachineProvider(
    record,
    "machine inspect",
    () => untilAborted(inspect({ hostId, resource, signal }), signal),
  );
  if (!invocation.ok) {
    deps.logger.warn(
      { hostId, error: invocation.error },
      "Machine inspect after daemon disconnect failed",
    );
    return null;
  }
  const parsed = inspectionSchema.safeParse(invocation.value);
  if (!parsed.success) {
    deps.logger.warn(
      { hostId, error: parsed.error.message },
      "Machine inspect returned an invalid result",
    );
    return null;
  }
  if (parsed.data.status !== "exited") return null;
  const machine: SystemThreadInterruptedMachine = {
    status: "exited",
    reason: parsed.data.reason,
    ...(parsed.data.detail === undefined ? {} : { detail: parsed.data.detail }),
    ...(parsed.data.exitedAt === undefined
      ? {}
      : { exitedAt: parsed.data.exitedAt }),
  };
  updateHost(deps.db, deps.hub, hostId, {
    statusMessage: machineExitStatusMessage(machine),
  });
  return machine;
}
