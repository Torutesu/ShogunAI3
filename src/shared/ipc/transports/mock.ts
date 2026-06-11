import { handleMockCommand, type MockContext } from "@/shared/ipc/mock/handler";

export type { MockContext } from "@/shared/ipc/mock/handler";

/** Thin mock transport used by ipc-client (returns raw data, not invoke envelope). */
export async function mockTransport(
  command: string,
  payload: unknown,
  ctx?: MockContext,
): Promise<unknown> {
  return handleMockCommand(command, payload, ctx);
}
