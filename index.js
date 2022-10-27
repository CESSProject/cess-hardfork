const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const cliProgress = require('cli-progress');
require("dotenv").config();
const { ApiPromise } = require('@polkadot/api');
const { HttpProvider } = require('@polkadot/rpc-provider');
const { xxhashAsHex } = require('@polkadot/util-crypto');
const execFileSync = require('child_process').execFileSync;
const execSync = require('child_process').execSync;

const BIN_PATH = path.join(__dirname, 'data', 'binary');
const WASM_PATH = path.join(__dirname, 'data', 'runtime.wasm');
const SCHEMA_PATH = path.join(__dirname, 'data', 'schema.json');
const HEX_PATH = path.join(__dirname, 'data', 'runtime.hex');
const MODULE_NAMES_PATH = path.join(__dirname, 'data', 'modules.json');
const FORKED_SPEC_PATH = path.join(__dirname, 'data', 'fork.json');
const EXPORTED_STATE_PATH = path.join(__dirname, 'data', 'exported_state.json');
const STATE_PAIRS_PATH = path.join(__dirname, 'data', 'state_pairs.json');

const ALICE = process.env.ALICE || ''
const FORKCHAIN = process.env.FORK_CHAIN || '';

/**
 * All module prefixes except those mentioned in the skippedModulesPrefix will be added to this by the script.
 * If you want to add any past module or part of a skipped module, add the prefix here manually.
 *
 * Any storage value’s hex can be logged via console.log(api.query.<module>.<call>.key([...opt params])),
 * e.g. console.log(api.query.timestamp.now.key()).
 *
 * If you want a map/doublemap key prefix, you can do it via .keyPrefix(),
 * e.g. console.log(api.query.system.account.keyPrefix()).
 *
 * For module hashing, do it via xxhashAsHex,
 * e.g. console.log(xxhashAsHex('System', 128)).
 */
let prefixes = ['0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9' /* System.Account */];
const skippedModulesPrefix = ['System', 'Session', 'Historical', 'Babe', 'Grandpa', 'Staking', 'Authorship', 'AuthorityDiscovery', 'ImOnline', 'Offences', 'BagsList', 'ElectionProviderMultiPhase'];

async function main() {
  ensureBinary();
  ensureWasm();
  let prefixes = await ensureMatchPrefixes();
  let kvPairs = await ensureOriginStateKvPairs();
  let forkedSpec = ensureForkedSpec();
  mergeToForkSpec(prefixes, kvPairs, forkedSpec);

  process.exit();
}

function createApi() {
  let api = undefined;
  async function createIfAbsent() {
    if (api) {
      return api;
    }
    // Using http endpoint since substrate's Ws endpoint has a size limit.
    const provider = new HttpProvider(process.env.HTTP_RPC_ENDPOINT || 'http://127.0.0.1:9933')
    console.log(chalk.green('We are intentionally using the HTTP endpoint. If you see any warnings about that, please ignore them.'));
    if (!fs.existsSync(SCHEMA_PATH)) {
      console.log(chalk.yellow('Custom Schema missing, using default schema.'));
      api = await ApiPromise.create({ provider });
    } else {
      const { types, rpc } = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
      api = await ApiPromise.create({
        provider,
        types,
        rpc,
      });
    }
    return api
  }
  return createIfAbsent;
};

const getApi = createApi();

async function ensureModuleNames() {
  if (fs.existsSync(MODULE_NAMES_PATH)) {
    return JSON.parse(fs.readFileSync(MODULE_NAMES_PATH, 'utf8'));
  }

  const api = await getApi();
  const metadata = await api.rpc.state.getMetadata();
  const modules = metadata.asLatest.pallets;
  let moduleNames = []
  modules.forEach((module) => {
    if (module.storage) {
      moduleNames.push(module.name.toString())
    }
  });
  return moduleNames;
}

async function ensureMatchPrefixes() {
  const moduleNames = await ensureModuleNames()
  // Populate the prefixes array
  moduleNames.forEach((moduleName) => {
    if (!skippedModulesPrefix.includes(moduleName)) {
      prefixes.push(xxhashAsHex(moduleName, 128));
    } else {
      console.log("skip module: %s", moduleName)
    }
  });
  console.log("%s prefixes:\n", prefixes.length, prefixes.join('\n'));
  return prefixes
}

function ensureBinary() {
  if (!fs.existsSync(BIN_PATH)) {
    console.log(chalk.red('Binary missing. Please copy the binary of your substrate node to the data folder and rename the binary to "binary"'));
    process.exit(1);
  }
  execFileSync('chmod', ['+x', BIN_PATH]);
}

function ensureWasm() {
  if (fs.existsSync(HEX_PATH)) {
    return
  }
  if (!fs.existsSync(WASM_PATH)) {
    console.log(chalk.red('WASM missing. Please copy the WASM blob of your substrate node to the data folder and rename it to "runtime.wasm"'));
    process.exit(1);
  }
  execSync('cat ' + WASM_PATH + ' | hexdump -ve \'/1 "%02x"\' > ' + HEX_PATH);
}

function ensureForkedSpec() {
  if (!fs.existsSync(FORKED_SPEC_PATH)) {
    if (FORKCHAIN == '') {
      console.log("build fork raw chain spec (dev)")
      execSync(BIN_PATH + ` build-spec --dev --raw > ` + FORKED_SPEC_PATH);
    } else {
      console.log("build fork raw chain spec (%s)", FORKCHAIN)
      execSync(BIN_PATH + ` build-spec --chain ${FORKCHAIN} --raw > ` + FORKED_SPEC_PATH);
    }
  }
  return JSON.parse(fs.readFileSync(FORKED_SPEC_PATH, 'utf8'));
}

async function ensureOriginStateKvPairs() {
  if (fs.existsSync(EXPORTED_STATE_PATH)) {
    const originalState = JSON.parse(fs.readFileSync(EXPORTED_STATE_PATH, 'utf8')).genesis.raw.top;
    return Object.entries(originalState);
  }

  if (fs.existsSync(STATE_PAIRS_PATH)) {
    console.log(chalk.yellow('Reusing cached storage. Delete ./data/storage.json and rerun the script if you want to fetch latest storage'));
  } else {
    await downloadOriginState();
  }
  return JSON.parse(fs.readFileSync(STATE_PAIRS_PATH, 'utf8'));
}

function mergeToForkSpec(prefixes, originKvPairs, forkedSpec) {
  // Grab the items to be moved, then iterate through and insert into storage
  originKvPairs
    .filter((i) => prefixes.some((prefix) => i[0].startsWith(prefix)))
    .forEach(([key, value]) => (forkedSpec.genesis.raw.top[key] = value));

  // Delete System.LastRuntimeUpgrade to ensure that the on_runtime_upgrade event is triggered
  delete forkedSpec.genesis.raw.top['0x26aa394eea5630e07c48ae0c9558cef7f9cce9c888469bb1a0dceaa129672ef8'];

  // Set the code to the current runtime code
  forkedSpec.genesis.raw.top['0x3a636f6465'] = '0x' + fs.readFileSync(HEX_PATH, 'utf8').trim();

  // To prevent the validator set from changing mid-test, set Staking.ForceEra to ForceNone ('0x02')
  //forkedSpec.genesis.raw.top['0x5f3e4907f716ac89b6347d15ececedcaf7dad0317324aecae8744b87fc95f2f3'] = '0x02';

  if (ALICE !== '') {
    // Set sudo key to //Alice
    forkedSpec.genesis.raw.top['0x5c0d1176a568c1f92944340dbfed9e9c530ebca703c85910e7164cb7d1c9e47b'] = '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';
  }

  fs.writeFileSync(FORKED_SPEC_PATH, JSON.stringify(forkedSpec, null, 4));

  console.log(`Forked genesis generated successfully. Find it at ${FORKED_SPEC_PATH}`);
}

///////////////////////////////////////////////////////////////////////////////////////////

const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
let chunksFetched = 0;
let separator = false;

async function downloadOriginState() {
  const api = await getApi()
  // The storage download will be split into 256^chunksLevel chunks.
  const chunksLevel = process.env.FORK_CHUNKS_LEVEL || 1;
  const totalChunks = Math.pow(256, chunksLevel);
  const fromBlockNum = process.env.FROM_BLOCK_NUM;
  //Download state of original chain
  
  let at;
  if (fromBlockNum) {
    console.log(chalk.green(`Fetching current state from block ${fromBlockNum} of the live chain. Please wait, it can take a while depending on the size of your chain.`));
    at = (await api.rpc.chain.getBlockHash(fromBlockNum)).toString();
  } else {
    console.log(chalk.green(`Fetching current state of the live chain. Please wait, it can take a while depending on the size of your chain.`));
    at = (await api.rpc.chain.getBlockHash()).toString();
  }
  
  progressBar.start(totalChunks, 0);
  const stream = fs.createWriteStream(STATE_PAIRS_PATH, { flags: 'a' });
  stream.write("[");
  await fetchChunks(api, "0x", chunksLevel, stream, at);
  stream.write("]");
  stream.end();
  progressBar.stop();
}

async function fetchChunks(api, prefix, levelsRemaining, stream, at) {
  if (levelsRemaining <= 0) {
    const pairs = await api.rpc.state.getPairs(prefix, at);
    if (pairs.length > 0) {
      separator ? stream.write(",") : separator = true;
      stream.write(JSON.stringify(pairs).slice(1, -1));
    }
    progressBar.update(++chunksFetched);
    return;
  }

  // Async fetch the last level
  if (process.env.QUICK_MODE && levelsRemaining == 1) {
    let promises = [];
    for (let i = 0; i < 256; i++) {
      promises.push(fetchChunks(api, prefix + i.toString(16).padStart(2, "0"), levelsRemaining - 1, stream, at));
    }
    await Promise.all(promises);
  } else {
    for (let i = 0; i < 256; i++) {
      await fetchChunks(api, prefix + i.toString(16).padStart(2, "0"), levelsRemaining - 1, stream, at);
    }
  }
}

main();