import { env } from "../env.js";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { ethers } from "ethers";
import { MerkleTree } from "merkletreejs";
import keccak256 from "keccak256";
import { getWeeks, updateWeekStatus, countCompletedLifecycleIntents } from "../store.js";
import { resolveDataDir } from "../paths.js";
import {
  getRequiredRuntimeValcoreAddress,
  getRuntimeChainIdBigInt,
  getConfiguredRuntimeChainIdBigInt,
  isValcoreChainEnabled,
} from "../network/chain-runtime.js";
import { getOnchainWeekState, sendApproveFinalizationOnchain } from "../network/valcore-chain-client.js";
import {
  ensureLifecycleIntent,
  markLifecycleIntentCompleted,
  markLifecycleIntentFailed,
  markLifecycleIntentSubmitted,
} from "./lifecycle-intent.js";

type ClaimRow = {
  address: string;
  principal: string;
  riskPayout: string;
  totalWithdraw: string;
};

type FinalizeMetadata = {
  root?: string;
  metadataHash?: string;
  retainedFeeWei?: string;
};

const parseJsonFile = <T>(path: string): T => {
  if (!existsSync(path)) {
    throw new Error(`Missing finalize artifact: ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as T;
};

const extractReactiveTxHash = (error: unknown): string | null => {
  const direct =
    typeof error === "object" && error !== null
      ? String((error as { reactiveTxHash?: unknown }).reactiveTxHash ?? "").trim().toLowerCase()
      : "";
  if (/^0x[0-9a-f]{64}$/u.test(direct)) return direct;
  return null;
};

const getIntentUpdatedAtMs = (intent: { updated_at?: unknown }) => {
  const raw = String(intent.updated_at ?? "").trim();
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
};

const run = async () => {
  const weeks = await getWeeks();
  const week = weeks[0];
  if (!week) throw new Error("No week found");
  if (String(week.status ?? "").toUpperCase() !== "FINALIZE_PENDING") {
    throw new Error(`Audit requires FINALIZE_PENDING week; got ${String(week.status ?? "UNKNOWN")}`);
  }

  const weekId = BigInt(week.id);
  const chainEnabled = isValcoreChainEnabled();
  const contractAddress = await getRequiredRuntimeValcoreAddress();
  const chainId = chainEnabled
    ? await getRuntimeChainIdBigInt()
    : await getConfiguredRuntimeChainIdBigInt();

  const outDir = resolveDataDir();
  const claimsPath = resolve(outDir, `claims-${week.id}.json`);
  const metadataPath = resolve(outDir, `metadata-${week.id}.json`);
  const claims = parseJsonFile<ClaimRow[]>(claimsPath);
  const metadata = parseJsonFile<FinalizeMetadata>(metadataPath);

  if (!Array.isArray(claims) || claims.length === 0) {
    throw new Error("Finalize audit failed: claims artifact is empty");
  }

  const leaves = claims.map((entry) =>
    ethers.solidityPackedKeccak256(
      ["address", "uint256", "uint256", "address", "uint256", "uint256", "uint256"],
      [
        contractAddress,
        chainId,
        weekId,
        entry.address,
        BigInt(entry.principal),
        BigInt(entry.riskPayout),
        BigInt(entry.totalWithdraw),
      ],
    ),
  );

  const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const computedRoot = tree.getHexRoot();

  const metadataJson = JSON.stringify(metadata, null, 2);
  const computedMetadataHash = ethers.keccak256(ethers.toUtf8Bytes(metadataJson));
  const metadataRoot = String(metadata.root ?? "").toLowerCase();

  if (!metadataRoot || metadataRoot !== computedRoot.toLowerCase()) {
    throw new Error("Finalize audit failed: metadata root does not match computed root");
  }

  const finalizeRound = Math.max(
    0,
    (await countCompletedLifecycleIntents(String(week.id), "finalize")) - 1,
  );
  const opKey = `week:${week.id}:finalize-approve:r${finalizeRound}`;
  let intent = await ensureLifecycleIntent({
    opKey,
    weekId: String(week.id),
    operation: "finalize-approve",
    details: {
      round: finalizeRound,
      computedRoot,
      computedMetadataHash,
      status: "FINALIZED",
    },
  });
  if (String(intent.status ?? "").toLowerCase() === "completed") {
    console.log(`finalize-audit skipped: lifecycle intent already completed for week ${week.id}`);
    return;
  }

  const expectedRetainedFee = BigInt(metadata.retainedFeeWei ?? "0");
  const isReactiveEvm = String(process.env.AUTOMATION_MODE_EFFECTIVE ?? env.AUTOMATION_MODE ?? "").trim().toUpperCase() === "REACTIVE";
  let txHash: string | null = intent.tx_hash ? String(intent.tx_hash).toLowerCase() : null;
  let reactiveTxHash: string | null = isReactiveEvm ? txHash : null;

  try {
    if (chainEnabled) {
      const state = await getOnchainWeekState(contractAddress, weekId);
      const onchainStatus = Number(state.status ?? 0);
      const onchainRetainedFee = BigInt(state.retainedFee ?? 0n);
      const onchainRoot = String(state.merkleRoot ?? "0x0").toLowerCase();
      const onchainMetadataHash = String(state.metadataHash ?? "0x0").toLowerCase();

      if (onchainStatus !== 4 && onchainStatus !== 5) {
        throw new Error(`Finalize audit failed: onchain status is ${onchainStatus}, expected 4 or 5`);
      }
      if (onchainRoot !== computedRoot.toLowerCase()) {
        throw new Error("Finalize audit failed: onchain merkle root mismatch");
      }
      if (onchainMetadataHash !== computedMetadataHash.toLowerCase()) {
        throw new Error("Finalize audit failed: onchain metadata hash mismatch");
      }
      if (onchainRetainedFee !== expectedRetainedFee) {
        throw new Error("Finalize audit failed: retained fee mismatch");
      }

      if (onchainStatus === 4 && !txHash) {
        try {
          txHash = await sendApproveFinalizationOnchain(contractAddress, weekId, opKey);
          if (isReactiveEvm) reactiveTxHash = txHash;
          intent =
            (await markLifecycleIntentSubmitted(intent, txHash, {
              txHash,
              computedRoot,
              computedMetadataHash,
              retainedFeeWei: expectedRetainedFee.toString(),
              chainExecuted: true,
              reactiveTxHash,
            })) ?? intent;
        } catch (error) {
          const dispatchedReactiveTx = extractReactiveTxHash(error);
          if (isReactiveEvm && dispatchedReactiveTx) {
            txHash = dispatchedReactiveTx;
            reactiveTxHash = dispatchedReactiveTx;
            intent =
              (await markLifecycleIntentSubmitted(intent, dispatchedReactiveTx, {
                txHash: dispatchedReactiveTx,
                computedRoot,
                computedMetadataHash,
                retainedFeeWei: expectedRetainedFee.toString(),
                chainExecuted: true,
                reactiveTxHash,
                pendingConfirmation: true,
              })) ?? intent;
            console.log(
              `[run-finalize-audit] reactive approve submitted tx=${dispatchedReactiveTx}; waiting callback confirmation`,
            );
            return;
          }
          throw error;
        }
      }

      const postApproveState = await getOnchainWeekState(contractAddress, weekId);
      const postApproveStatus = Number(postApproveState.status ?? 0);
      if (postApproveStatus !== 5) {
        if (isReactiveEvm && txHash) {
          const pendingSinceMs = getIntentUpdatedAtMs(intent as { updated_at?: unknown });
          const reactiveStallGraceMs = Math.max(
            15_000,
            Number(env.REACTIVE_STALL_GRACE_SECONDS ?? "120") * 1000,
          );
          if (pendingSinceMs > 0 && Date.now() - pendingSinceMs > reactiveStallGraceMs) {
            throw new Error(
              `DETERMINISTIC: finalize-audit reactive callback timeout for week ${week.id}; tx=${txHash}; on-chain status=${postApproveStatus}`,
            );
          }
          console.log(
            `[run-finalize-audit] reactive callback pending for week ${week.id}; current on-chain status=${postApproveStatus}`,
          );
          return;
        }
        throw new Error(`Finalize audit failed: on-chain status is ${postApproveStatus}, expected 5 (FINALIZED)`);
      }
    }

    await updateWeekStatus(week.id, "FINALIZED");

    await markLifecycleIntentCompleted(intent, {
      txHash,
      computedRoot,
      computedMetadataHash,
      retainedFeeWei: expectedRetainedFee.toString(),
      status: "FINALIZED",
      chainExecuted: chainEnabled && Boolean(txHash),
      reactiveTxHash,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markLifecycleIntentFailed(intent, message, {
      txHash,
      computedRoot,
      computedMetadataHash,
      retainedFeeWei: expectedRetainedFee.toString(),
      status: "FINALIZED",
      chainExecuted: chainEnabled && Boolean(txHash),
      reactiveTxHash,
    });
    throw error;
  }
};

run().catch((error) => {
  console.error("finalize-audit job failed", error);
  process.exit(1);
});
