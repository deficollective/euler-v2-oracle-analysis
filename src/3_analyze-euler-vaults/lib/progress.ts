import { promises as fs } from "fs";
import { existsSync } from "fs";
import type { Progress, RouterDeployment, VaultDeployment } from "./types.js";

// Output file paths - all in the output/ subfolder
const OUTPUT_DIR = "src/analyze-euler-vaults/output";
const PROGRESS_FILE = `${OUTPUT_DIR}/vault-vendor-progress.json`;
const ROUTER_DEPLOYMENTS_FILE = `${OUTPUT_DIR}/router-deployments.json`;
const VAULT_DEPLOYMENTS_FILE = `${OUTPUT_DIR}/vault-deployments.json`;

/**
 * Load progress from file or return fresh progress object
 */
export async function loadProgress(): Promise<Progress> {
  try {
    if (existsSync(PROGRESS_FILE)) {
      const data = await fs.readFile(PROGRESS_FILE, "utf-8");
      return JSON.parse(data) as Progress;
    }
  } catch (error) {
    console.log("No valid progress file found, starting fresh");
  }
  return {
    routers: {},
    vaults: {},
    processedRouters: {},
    processedVaults: {},
  };
}

/**
 * Save progress to file
 */
export async function saveProgress(progress: Progress): Promise<void> {
  // Custom replacer to handle BigInt serialization
  const replacer = (_key: string, value: unknown) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };

  await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress, replacer, 2));
}

/**
 * Save router deployments to file
 */
export async function saveRouterDeployments(
  deployments: RouterDeployment[]
): Promise<void> {
  await fs.writeFile(
    ROUTER_DEPLOYMENTS_FILE,
    JSON.stringify(deployments, null, 2)
  );
  console.log(
    `✓ Saved ${deployments.length} router deployments to ${ROUTER_DEPLOYMENTS_FILE}`
  );
}

/**
 * Load router deployments from file
 */
export async function loadRouterDeployments(): Promise<RouterDeployment[]> {
  try {
    if (existsSync(ROUTER_DEPLOYMENTS_FILE)) {
      const data = await fs.readFile(ROUTER_DEPLOYMENTS_FILE, "utf-8");
      return JSON.parse(data) as RouterDeployment[];
    }
  } catch (error) {
    console.log("No router deployments file found");
  }
  return [];
}

/**
 * Save vault deployments to file
 */
export async function saveVaultDeployments(
  deployments: VaultDeployment[]
): Promise<void> {
  await fs.writeFile(
    VAULT_DEPLOYMENTS_FILE,
    JSON.stringify(deployments, null, 2)
  );
  console.log(
    `✓ Saved ${deployments.length} vault deployments to ${VAULT_DEPLOYMENTS_FILE}`
  );
}

/**
 * Load vault deployments from file
 */
export async function loadVaultDeployments(): Promise<VaultDeployment[]> {
  try {
    if (existsSync(VAULT_DEPLOYMENTS_FILE)) {
      const data = await fs.readFile(VAULT_DEPLOYMENTS_FILE, "utf-8");
      return JSON.parse(data) as VaultDeployment[];
    }
  } catch (error) {
    console.log("No vault deployments file found");
  }
  return [];
}
