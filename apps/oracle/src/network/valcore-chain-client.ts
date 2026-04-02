import { ethers } from "ethers";
import { env } from "../env.js";
import {
  getRuntimeProvider,
  getRequiredRuntimeOraclePrivateKey,
  getRequiredRuntimeAuditorPrivateKey,
  getRequiredRuntimeContractAdminPrivateKey,
  getRequiredRuntimePauserPrivateKey,
  getRequiredRuntimeFaucetMinterPrivateKey,
} from "./chain-runtime.js";
import { sendTxWithPolicy } from "./tx-policy.js";

export type ChainWeekState = {
  startAt: bigint;
  lockAt: bigint;
  endAt: bigint;
  finalizedAt: bigint;
  status: number;
  riskCommitted: bigint;
  retainedFee: bigint;
  merkleRoot: string;
  metadataHash: string;
};

export type ChainPositionState = {
  principal: bigint;
  risk: bigint;
  forfeitedReward: bigint;
  lineupHash: string;
  swaps: number;
  claimed: boolean;
};

type EvmRole = "oracle" | "auditor" | "contract_admin" | "pauser" | "faucet_minter";

const REACTIVE_ACTION_LOCK = 2;
const REACTIVE_ACTION_START = 3;
const REACTIVE_EXECUTED_TOPIC0 = ethers.id("ReactiveLifecycleExecuted(bytes32,uint8,uint256)");

const REACTIVE_DISPATCHER_ABI = [
  "function dispatch(bytes payload,uint64 gasLimit)",
  "function coverDebt() payable",
  "function destinationChainId() view returns (uint256)",
  "function destinationReceiver() view returns (address)",
  "function operator() view returns (address)",
] as const;
const REACTIVE_RECEIVER_ABI = [
  "function rxCreateWeek(address,bytes32,uint256,uint64,uint64,uint64)",
  "function rxTransition(address,bytes32,uint8,uint256,bool)",
  "function rxFinalize(address,bytes32,uint256,bytes32,bytes32,uint256,bool)",
  "function rxApprove(address,bytes32,uint256)",
  "function rxReject(address,bytes32,uint256)",
] as const;
const REACTIVE_RECEIVER_VIEW_ABI = [
  "function reactiveSender() view returns (address)",
] as const;
const REACTIVE_SYSTEM_ABI = [
  "function debt(address) view returns (uint256)",
] as const;
const REACTIVE_SYSTEM_ADDRESS = "0x0000000000000000000000000000000000fffFfF";

const normalizeHex = (value: unknown) => {
  const raw = String(value ?? "").trim();
  if (!raw) return "0x0";
  if (raw.startsWith("0x") || raw.startsWith("0X")) return raw.toLowerCase();
  return `0x${BigInt(raw).toString(16)}`;
};

const asBigInt = (value: unknown): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) return 0n;
    return BigInt(normalized);
  }
  return 0n;
};

const asNumber = (value: unknown) => Number(asBigInt(value));

const normalizeAddress = (value: string, label: string) => {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${label} is not configured`);
  }
  return ethers.getAddress(normalized);
};

const toPositiveIntEnv = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const resolveLifecycleIntentOpKey = (value: string | undefined, fallback: string) => {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
};

const toIntentId = (opKey: string) => ethers.id(opKey);

type ReactiveTransportConfig = {
  rpcUrl: string;
  chainId: number;
  executorPrivateKey: string;
  dispatcherAddress: string;
  receiverAddress: string;
  gasLimit: bigint;
  waitMs: number;
  pollMs: number;
};

let reactiveDispatcherPreflightCacheKey: string | null = null;
let reactiveDispatcherResolvedSender: string | null = null;

const getReactiveTransportConfig = async (): Promise<ReactiveTransportConfig | null> => {
  const mode = String(process.env.AUTOMATION_MODE_EFFECTIVE ?? env.AUTOMATION_MODE ?? "").trim().toUpperCase();
  if (mode !== "REACTIVE") return null;

  const rpcUrl = String(env.REACTIVE_CHAIN_RPC_URL ?? "").trim();
  const executorPrivateKey = String(env.REACTIVE_EXECUTOR_PRIVATE_KEY ?? "").trim();
  const dispatcherAddressRaw = String(env.REACTIVE_DISPATCHER_ADDRESS ?? "").trim();
  const receiverAddressRaw = String(env.REACTIVE_RECEIVER_ADDRESS ?? "").trim();

  if (!rpcUrl || !executorPrivateKey || !dispatcherAddressRaw || !receiverAddressRaw) {
    throw new Error(
      "Reactive transport is enabled but REACTIVE_CHAIN_RPC_URL / REACTIVE_EXECUTOR_PRIVATE_KEY / REACTIVE_DISPATCHER_ADDRESS / REACTIVE_RECEIVER_ADDRESS are missing",
    );
  }

  return {
    rpcUrl,
    chainId: toPositiveIntEnv(env.REACTIVE_CHAIN_ID, 5318007),
    executorPrivateKey,
    dispatcherAddress: normalizeAddress(dispatcherAddressRaw, "REACTIVE_DISPATCHER_ADDRESS"),
    receiverAddress: normalizeAddress(receiverAddressRaw, "REACTIVE_RECEIVER_ADDRESS"),
    gasLimit: BigInt(toPositiveIntEnv(env.REACTIVE_CALLBACK_GAS_LIMIT, 900000)),
    waitMs: toPositiveIntEnv(env.REACTIVE_DESTINATION_WAIT_MS, 240000),
    pollMs: Math.max(1000, toPositiveIntEnv(env.REACTIVE_DESTINATION_POLL_MS, 3000)),
  };
};

const ensureReactiveDispatcherPreflight = async (config: ReactiveTransportConfig) => {
  const cacheKey = [
    config.rpcUrl.toLowerCase(),
    String(config.chainId),
    config.dispatcherAddress.toLowerCase(),
    config.receiverAddress.toLowerCase(),
    config.executorPrivateKey.toLowerCase(),
  ].join("|");
  if (reactiveDispatcherPreflightCacheKey === cacheKey) return;

  const reactiveProvider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
  const dispatcher = new ethers.Contract(config.dispatcherAddress, REACTIVE_DISPATCHER_ABI, reactiveProvider);

  const destinationProvider = await getRuntimeProvider();
  const destinationNetwork = await destinationProvider.getNetwork();
  const expectedDestinationChainId = BigInt(destinationNetwork.chainId);
  const expectedDestinationReceiver = config.receiverAddress.toLowerCase();
  const expectedOperator = new ethers.Wallet(config.executorPrivateKey).address.toLowerCase();

  const [destinationChainId, destinationReceiver, operator] = await Promise.all([
    dispatcher.destinationChainId(),
    dispatcher.destinationReceiver(),
    dispatcher.operator(),
  ]);

  if (BigInt(destinationChainId) !== expectedDestinationChainId) {
    throw new Error(
      `Reactive dispatcher destinationChainId mismatch: expected=${expectedDestinationChainId.toString()} got=${BigInt(destinationChainId).toString()}`,
    );
  }

  if (String(destinationReceiver).toLowerCase() !== expectedDestinationReceiver) {
    throw new Error(
      `Reactive dispatcher destinationReceiver mismatch: expected=${expectedDestinationReceiver} got=${String(destinationReceiver).toLowerCase()}`,
    );
  }

  if (String(operator).toLowerCase() !== expectedOperator) {
    throw new Error(
      `Reactive dispatcher operator mismatch: expected=${expectedOperator} got=${String(operator).toLowerCase()}`,
    );
  }

  const mapping = await reactiveProvider.send("rnk_getRnkAddressMapping", [config.dispatcherAddress]);
  const mappedRvmIdRaw = String(
    (mapping as { rvmId?: unknown; RvmId?: unknown } | null | undefined)?.rvmId ??
      (mapping as { rvmId?: unknown; RvmId?: unknown } | null | undefined)?.RvmId ??
      "",
  ).trim();
  if (!mappedRvmIdRaw) {
    throw new Error("Reactive dispatcher RVM mapping is missing (rnk_getRnkAddressMapping)");
  }
  const expectedReactiveSender = ethers.getAddress(mappedRvmIdRaw).toLowerCase();
  const receiver = new ethers.Contract(config.receiverAddress, REACTIVE_RECEIVER_VIEW_ABI, destinationProvider);
  const configuredReactiveSender = String(await receiver.reactiveSender()).toLowerCase();
  if (configuredReactiveSender !== expectedReactiveSender) {
    throw new Error(
      `Reactive receiver reactiveSender mismatch: expected=${expectedReactiveSender} got=${configuredReactiveSender}`,
    );
  }

  const reactiveSystem = new ethers.Contract(REACTIVE_SYSTEM_ADDRESS, REACTIVE_SYSTEM_ABI, reactiveProvider);
  let [dispatcherBalance, dispatcherDebt] = await Promise.all([
    reactiveProvider.getBalance(config.dispatcherAddress),
    reactiveSystem.debt(config.dispatcherAddress),
  ]);
  if (dispatcherBalance < dispatcherDebt) {
    const executor = new ethers.Wallet(config.executorPrivateKey, reactiveProvider);
    const executorBalance = await reactiveProvider.getBalance(executor.address);
    const bufferRaw = String(process.env.REACTIVE_DISPATCHER_DEBT_BUFFER_ETH ?? "0.002").trim();
    const bufferWei = ethers.parseEther(bufferRaw || "0.002");
    const shortfall = dispatcherDebt - dispatcherBalance;
    const requiredValue = shortfall + bufferWei;

    const gasPrice = await reactiveProvider.getFeeData().then((fee) => fee.gasPrice ?? 0n).catch(() => 0n);
    const estimatedGasReserve = gasPrice > 0n ? gasPrice * 300_000n : ethers.parseEther("0.0001");
    if (executorBalance < requiredValue + estimatedGasReserve) {
      throw new Error(
        `Reactive dispatcher underfunded and executor has insufficient balance: dispatcher=${config.dispatcherAddress} balance=${ethers.formatEther(dispatcherBalance)} debt=${ethers.formatEther(dispatcherDebt)} requiredTopup=${ethers.formatEther(requiredValue)} executor=${executor.address} executorBalance=${ethers.formatEther(executorBalance)}`,
      );
    }

    const topupTx = await executor.sendTransaction({
      to: config.dispatcherAddress,
      value: requiredValue,
    });
    await topupTx.wait();

    const dispatcherWithExecutor = new ethers.Contract(config.dispatcherAddress, REACTIVE_DISPATCHER_ABI, executor);
    const coverTx = await dispatcherWithExecutor.coverDebt();
    await coverTx.wait();

    [dispatcherBalance, dispatcherDebt] = await Promise.all([
      reactiveProvider.getBalance(config.dispatcherAddress),
      reactiveSystem.debt(config.dispatcherAddress),
    ]);

    if (dispatcherBalance < dispatcherDebt) {
      throw new Error(
        `Reactive dispatcher still underfunded after auto-cover: address=${config.dispatcherAddress} balance=${ethers.formatEther(dispatcherBalance)} debt=${ethers.formatEther(dispatcherDebt)}`,
      );
    }
  }

  reactiveDispatcherResolvedSender = expectedReactiveSender;
  reactiveDispatcherPreflightCacheKey = cacheKey;
};

const getReactiveSenderForPayload = async (config: ReactiveTransportConfig): Promise<string> => {
  await ensureReactiveDispatcherPreflight(config);
  if (!reactiveDispatcherResolvedSender) {
    throw new Error("Reactive dispatcher sender mapping is unavailable");
  }
  return ethers.getAddress(reactiveDispatcherResolvedSender);
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const REACTIVE_DESTINATION_READ_TIMEOUT_MS = Math.max(
  3000,
  toPositiveIntEnv(process.env.REACTIVE_DESTINATION_READ_TIMEOUT_MS, 10000),
);

const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForWeekStatus = async (
  leagueAddress: string,
  weekId: bigint,
  expectedStatus: number,
  waitMs: number,
  pollMs: number,
  label: string,
) => {
  const deadline = Date.now() + waitMs;
  let lastStatus = -1;
  let lastReadError: string | null = null;
  while (Date.now() <= deadline) {
    try {
      const state = await withTimeout(
        getOnchainWeekState(leagueAddress, weekId),
        REACTIVE_DESTINATION_READ_TIMEOUT_MS,
        `${label}: getOnchainWeekState`,
      );
      const status = Number(state.status ?? 0);
      if (status === expectedStatus) {
        return;
      }
      lastStatus = status;
      lastReadError = null;
    } catch (error) {
      lastReadError = error instanceof Error ? error.message : String(error);
    }
    await sleepMs(pollMs);
  }
  const readSuffix = lastReadError ? `; lastReadError=${lastReadError}` : "";
  throw new Error(
    `${label}: destination week status did not reach ${expectedStatus} in ${waitMs}ms (last=${lastStatus})${readSuffix}`,
  );
};

const findReactiveCallbackDestinationTx = async (
  receiverAddress: string,
  intentId: string,
  fromBlockInclusive: number,
): Promise<string | null> => {
  const provider = await getRuntimeProvider();
  const latest = await provider.getBlockNumber();
  if (latest < fromBlockInclusive) return null;

  const logs = await provider.getLogs({
    address: receiverAddress,
    fromBlock: fromBlockInclusive,
    toBlock: latest,
    topics: [REACTIVE_EXECUTED_TOPIC0, intentId],
  });

  const txHash = String(logs[logs.length - 1]?.transactionHash ?? "").trim().toLowerCase();
  if (!txHash) return null;
  return txHash;
};

type ReactiveDispatchResult = {
  reactiveTxHash: string;
  destinationTxHash: string | null;
};

const dispatchReactiveCallback = async (
  payload: string,
  label: string,
  leagueAddress: string,
  weekId: bigint,
  expectedStatusAfter: number,
  intentId: string,
): Promise<ReactiveDispatchResult> => {
  const config = await getReactiveTransportConfig();
  if (!config) {
    throw new Error("Reactive dispatch requested while reactive transport is disabled");
  }
  await ensureReactiveDispatcherPreflight(config);

  const destinationProvider = await getRuntimeProvider();
  const startBlock = await destinationProvider.getBlockNumber();

  const reactiveProvider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
  const reactiveWallet = new ethers.Wallet(config.executorPrivateKey, reactiveProvider);
  const dispatcher = new ethers.Contract(config.dispatcherAddress, REACTIVE_DISPATCHER_ABI, reactiveWallet);
  const sent = await sendTxWithPolicy({
    label,
    signer: reactiveWallet,
    send: (overrides) => (dispatcher as any).dispatch(payload, config.gasLimit, overrides),
  });

  const reactiveTxHash = String(sent.txHash ?? "").toLowerCase();
  try {
    await waitForWeekStatus(leagueAddress, weekId, expectedStatusAfter, config.waitMs, config.pollMs, label);

    const destinationTxHash = await findReactiveCallbackDestinationTx(config.receiverAddress, intentId, startBlock);
    return {
      reactiveTxHash,
      destinationTxHash,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const wrapped = new Error(
      `${label}: reactive tx submitted ${reactiveTxHash}; destination confirmation pending. ${message}`,
    ) as Error & { reactiveTxHash?: string; destinationTxHash?: string | null };
    wrapped.reactiveTxHash = reactiveTxHash;
    try {
      wrapped.destinationTxHash = await findReactiveCallbackDestinationTx(
        config.receiverAddress,
        intentId,
        startBlock,
      );
    } catch {
      wrapped.destinationTxHash = null;
    }
    throw wrapped;
  }
};

const getEvmPrivateKeyByRole = async (role: EvmRole): Promise<string> => {
  if (role === "oracle") return getRequiredRuntimeOraclePrivateKey();
  if (role === "auditor") return getRequiredRuntimeAuditorPrivateKey();
  if (role === "contract_admin") return getRequiredRuntimeContractAdminPrivateKey();
  if (role === "pauser") return getRequiredRuntimePauserPrivateKey();
  return getRequiredRuntimeFaucetMinterPrivateKey();
};

const sendEvmChainTx = async (
  role: EvmRole,
  contractAddress: string,
  abi: readonly string[],
  label: string,
  sender: (contract: ethers.Contract, overrides: Record<string, bigint>) => Promise<unknown>,
): Promise<string> => {
  const provider = await getRuntimeProvider();
  const privateKey = await getEvmPrivateKeyByRole(role);
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(contractAddress, abi, wallet);

  const sent = await sendTxWithPolicy({
    label,
    signer: wallet,
    send: (overrides) =>
      sender(
        contract,
        overrides,
      ) as Promise<{ hash: string; wait: (confirmations?: number) => Promise<ethers.TransactionReceipt | null> }>,
  });

  return sent.txHash;
};

export const getOnchainFeeBps = async (leagueAddress: string): Promise<number> => {
  const provider = await getRuntimeProvider();
  const league = new ethers.Contract(leagueAddress, ["function feeBps() view returns (uint16)"], provider);
  return Number(await league.feeBps());
};

export const getOnchainWeekState = async (leagueAddress: string, weekId: bigint): Promise<ChainWeekState> => {
  const provider = await getRuntimeProvider();
  const league = new ethers.Contract(
    leagueAddress,
    [
      "function weekStates(uint256) view returns (uint64,uint64,uint64,uint64,uint8,uint128,uint128,bytes32,bytes32)",
    ],
    provider,
  );
  const state = await league.weekStates(weekId);
  return {
    startAt: asBigInt(state[0]),
    lockAt: asBigInt(state[1]),
    endAt: asBigInt(state[2]),
    finalizedAt: asBigInt(state[3]),
    status: asNumber(state[4]),
    riskCommitted: asBigInt(state[5]),
    retainedFee: asBigInt(state[6]),
    merkleRoot: normalizeHex(state[7]),
    metadataHash: normalizeHex(state[8]),
  };
};

export const getOnchainPosition = async (
  leagueAddress: string,
  weekId: bigint,
  address: string,
): Promise<ChainPositionState> => {
  const provider = await getRuntimeProvider();
  const league = new ethers.Contract(
    leagueAddress,
    [
      "function positions(uint256,address) view returns (uint128 principal,uint128 risk,uint128 forfeitedReward,bytes32 lineupHash,uint8 swaps,bool claimed)",
    ],
    provider,
  );
  const state = await league.positions(weekId, address);
  return {
    principal: asBigInt(state.principal ?? state[0]),
    risk: asBigInt(state.risk ?? state[1]),
    forfeitedReward: asBigInt(state.forfeitedReward ?? state[2]),
    lineupHash: normalizeHex(state.lineupHash ?? state[3]),
    swaps: asNumber(state.swaps ?? state[4]),
    claimed: Boolean(state.claimed ?? state[5]),
  };
};

export const getOnchainTestMode = async (leagueAddress: string): Promise<boolean> => {
  const provider = await getRuntimeProvider();
  const league = new ethers.Contract(leagueAddress, ["function testMode() view returns (bool)"], provider);
  return Boolean(await league.testMode());
};

export const getOnchainPaused = async (leagueAddress: string): Promise<boolean> => {
  const provider = await getRuntimeProvider();
  const league = new ethers.Contract(leagueAddress, ["function paused() view returns (bool)"], provider);
  return Boolean(await league.paused());
};

export const createWeekOnchain = async (
  leagueAddress: string,
  weekId: bigint,
  startAt: number,
  lockAt: number,
  endAt: number,
  lifecycleIntentOpKey?: string,
): Promise<string> => {
  const opKey = resolveLifecycleIntentOpKey(lifecycleIntentOpKey, `create:${weekId.toString()}:${startAt}:${lockAt}:${endAt}`);
  const intentId = toIntentId(opKey);

  const reactive = await getReactiveTransportConfig();
  if (reactive) {
    const reactiveSender = await getReactiveSenderForPayload(reactive);
    const receiverIface = new ethers.Interface(REACTIVE_RECEIVER_ABI);
    const payload = receiverIface.encodeFunctionData("rxCreateWeek", [
      reactiveSender,
      intentId,
      weekId,
      startAt,
      lockAt,
      endAt,
    ]);

    const dispatched = await dispatchReactiveCallback(
      payload,
      `reactive.createWeek(${weekId.toString()})`,
      leagueAddress,
      weekId,
      1,
      intentId,
    );

    return dispatched.reactiveTxHash;
  }

  return sendEvmChainTx(
    "oracle",
    leagueAddress,
    ["function createWeekWithIntent(bytes32,uint256,uint64,uint64,uint64)"],
    `createWeekWithIntent(${weekId.toString()})`,
    (league, overrides) =>
      (league as any).createWeekWithIntent(
        intentId,
        weekId,
        startAt,
        lockAt,
        endAt,
        overrides,
      ),
  );
};

export const sendTransitionOnchain = async (
  leagueAddress: string,
  action: "lock" | "start",
  weekId: bigint,
  useForce: boolean,
  lifecycleIntentOpKey?: string,
): Promise<string> => {
  const opKey = resolveLifecycleIntentOpKey(
    lifecycleIntentOpKey,
    `transition:${action}:${weekId.toString()}:${useForce ? "force" : "timed"}`,
  );
  const intentId = toIntentId(opKey);

  const reactive = await getReactiveTransportConfig();
  if (reactive) {
    const reactiveSender = await getReactiveSenderForPayload(reactive);
    const actionCode = action === "lock" ? REACTIVE_ACTION_LOCK : REACTIVE_ACTION_START;
    const expectedStatus = action === "lock" ? 2 : 3;
    const receiverIface = new ethers.Interface(REACTIVE_RECEIVER_ABI);
    const payload = receiverIface.encodeFunctionData("rxTransition", [
      reactiveSender,
      intentId,
      actionCode,
      weekId,
      useForce,
    ]);

    const dispatched = await dispatchReactiveCallback(
      payload,
      `reactive.${action}Week(${weekId.toString()})`,
      leagueAddress,
      weekId,
      expectedStatus,
      intentId,
    );

    return dispatched.reactiveTxHash;
  }

  const abi = [
    "function lockWeekWithIntent(bytes32,uint256)",
    "function startWeekWithIntent(bytes32,uint256)",
    "function forceLockWeekWithIntent(bytes32,uint256)",
    "function forceStartWeekWithIntent(bytes32,uint256)",
  ] as const;
  const fnName = useForce
    ? action === "lock"
      ? "forceLockWeekWithIntent"
      : "forceStartWeekWithIntent"
    : action === "lock"
    ? "lockWeekWithIntent"
    : "startWeekWithIntent";

  return sendEvmChainTx("oracle", leagueAddress, abi, `${fnName}(${weekId.toString()})`, (league, overrides) =>
    (league as Record<string, (...args: unknown[]) => Promise<unknown>>)[fnName](intentId, weekId, overrides),
  );
};

export const sendFinalizeOnchain = async (
  leagueAddress: string,
  weekId: bigint,
  root: string,
  metadataHash: string,
  retainedFee: bigint,
  useForce: boolean,
  lifecycleIntentOpKey?: string,
): Promise<string> => {
  const opKey = resolveLifecycleIntentOpKey(
    lifecycleIntentOpKey,
    `finalize:${weekId.toString()}:${String(root).toLowerCase()}:${String(metadataHash).toLowerCase()}:${retainedFee.toString()}:${useForce ? "force" : "timed"}`,
  );
  const intentId = toIntentId(opKey);

  const reactive = await getReactiveTransportConfig();
  if (reactive) {
    const reactiveSender = await getReactiveSenderForPayload(reactive);
    const receiverIface = new ethers.Interface(REACTIVE_RECEIVER_ABI);
    const payload = receiverIface.encodeFunctionData("rxFinalize", [
      reactiveSender,
      intentId,
      weekId,
      root,
      metadataHash,
      retainedFee,
      useForce,
    ]);

    const dispatched = await dispatchReactiveCallback(
      payload,
      `reactive.finalizeWeek(${weekId.toString()})`,
      leagueAddress,
      weekId,
      4,
      intentId,
    );

    return dispatched.reactiveTxHash;
  }

  const abi = [
    "function finalizeWeekWithIntent(bytes32,uint256,bytes32,bytes32,uint256)",
    "function forceFinalizeWeekWithIntent(bytes32,uint256,bytes32,bytes32,uint256)",
  ] as const;
  const fnName = useForce ? "forceFinalizeWeekWithIntent" : "finalizeWeekWithIntent";

  return sendEvmChainTx("oracle", leagueAddress, abi, `${fnName}(${weekId.toString()})`, (league, overrides) =>
    (league as Record<string, (...args: unknown[]) => Promise<unknown>>)[fnName](
      intentId,
      weekId,
      root,
      metadataHash,
      retainedFee,
      overrides,
    ),
  );
};

export const sendApproveFinalizationOnchain = async (
  leagueAddress: string,
  weekId: bigint,
  lifecycleIntentOpKey?: string,
): Promise<string> => {
  const opKey = resolveLifecycleIntentOpKey(lifecycleIntentOpKey, `approve:${weekId.toString()}`);
  const intentId = toIntentId(opKey);

  const reactive = await getReactiveTransportConfig();
  if (reactive) {
    const reactiveSender = await getReactiveSenderForPayload(reactive);
    const receiverIface = new ethers.Interface(REACTIVE_RECEIVER_ABI);
    const payload = receiverIface.encodeFunctionData("rxApprove", [
      reactiveSender,
      intentId,
      weekId,
    ]);

    const dispatched = await dispatchReactiveCallback(
      payload,
      `reactive.approveFinalization(${weekId.toString()})`,
      leagueAddress,
      weekId,
      5,
      intentId,
    );

    return dispatched.reactiveTxHash;
  }

  return sendEvmChainTx(
    "auditor",
    leagueAddress,
    ["function approveFinalizationWithIntent(bytes32,uint256)"],
    `approveFinalizationWithIntent(${weekId.toString()})`,
    (league, overrides) => (league as any).approveFinalizationWithIntent(intentId, weekId, overrides),
  );
};

export const sendRejectFinalizationOnchain = async (
  leagueAddress: string,
  weekId: bigint,
  lifecycleIntentOpKey?: string,
): Promise<string> => {
  const opKey = resolveLifecycleIntentOpKey(lifecycleIntentOpKey, `reject:${weekId.toString()}`);
  const intentId = toIntentId(opKey);

  const reactive = await getReactiveTransportConfig();
  if (reactive) {
    const reactiveSender = await getReactiveSenderForPayload(reactive);
    const receiverIface = new ethers.Interface(REACTIVE_RECEIVER_ABI);
    const payload = receiverIface.encodeFunctionData("rxReject", [
      reactiveSender,
      intentId,
      weekId,
    ]);

    const dispatched = await dispatchReactiveCallback(
      payload,
      `reactive.rejectFinalization(${weekId.toString()})`,
      leagueAddress,
      weekId,
      3,
      intentId,
    );

    return dispatched.reactiveTxHash;
  }

  return sendEvmChainTx(
    "auditor",
    leagueAddress,
    ["function rejectFinalizationWithIntent(bytes32,uint256)"],
    `rejectFinalizationWithIntent(${weekId.toString()})`,
    (league, overrides) => (league as any).rejectFinalizationWithIntent(intentId, weekId, overrides),
  );
};

export const sendSetTestModeOnchain = async (leagueAddress: string, enabled: boolean): Promise<string> => {
  return sendEvmChainTx(
    "contract_admin",
    leagueAddress,
    ["function setTestMode(bool)"],
    "setTestMode",
    (league, overrides) =>
      (league as any).setTestMode(enabled, overrides),
  );
};

export const sendPauseOnchain = async (leagueAddress: string): Promise<string> => {
  return sendEvmChainTx(
    "pauser",
    leagueAddress,
    ["function pause()"],
    "pause",
    (league, overrides) => (league as any).pause(overrides),
  );
};

export const sendUnpauseOnchain = async (leagueAddress: string): Promise<string> => {
  return sendEvmChainTx(
    "pauser",
    leagueAddress,
    ["function unpause()"],
    "unpause",
    (league, overrides) =>
      (league as any).unpause(overrides),
  );
};

export const isOnchainTxSuccessful = async (txHash: string): Promise<boolean> => {
  const provider = await getRuntimeProvider();
  const receipt = await provider.getTransactionReceipt(txHash);
  return Boolean(receipt && Number(receipt.status) === 1);
};

export const mintStablecoinOnchain = async (
  stablecoinAddress: string,
  recipient: string,
  amountWei: bigint,
): Promise<string> => {
  return sendEvmChainTx(
    "faucet_minter",
    stablecoinAddress,
    ["function mint(address,uint256)"],
    `faucetMint(${recipient})`,
    (token, overrides) =>
      (token as any).mint(recipient, amountWei, overrides),
  );
};

