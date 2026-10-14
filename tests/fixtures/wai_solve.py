# Prints a WebArena-Infinity app's seed state and the state after the app's own
# solver for one real or function task. The test agent pushes both, as the page would.
import copy
import importlib.util
import json
import sys

app_dir, kind, task = sys.argv[1:4]
spec = importlib.util.spec_from_file_location("sanity", f"{app_dir}/sanity_check_{kind}.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
seed = (getattr(mod, "load_seed_state", None) or mod.generate_seed_state)()
solved = copy.deepcopy(seed)
mod.SOLVERS[task](solved)
print(json.dumps({"seed": seed, "solved": solved}))
