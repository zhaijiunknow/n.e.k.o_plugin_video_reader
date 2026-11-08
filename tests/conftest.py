"""Test this checkout against a separately installed N.E.K.O host SDK."""
import importlib
import importlib.util
import os
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
# The default sibling layout works without a host plugin-directory junction.
# Override it when the SDK checkout lives elsewhere; an installed SDK also works.
host = Path(os.environ.get("NEKO_HOST_ROOT", str(root.parent / "N.E.K.O")))
if (host / "plugin" / "sdk").is_dir():
    sys.path.insert(0, str(host))
vendor = root / "vendor"
if vendor.is_dir():
    sys.path.insert(0, str(vendor))

# The market review lints this file with `ruff --ignore-noqa`, so a `# noqa: E402`
# cannot excuse an import placed after the sys.path setup above. Importing through
# importlib has the same effect without a module-level import statement to flag.
plugin_plugins = importlib.import_module("plugin.plugins")

# Never accidentally test an older installed copy in the host plugins folder.
name = "plugin.plugins.video_reader"
spec = importlib.util.spec_from_file_location(name, root / "__init__.py", submodule_search_locations=[str(root)])
module = importlib.util.module_from_spec(spec)
sys.modules[name] = module
setattr(plugin_plugins, "video_reader", module)
spec.loader.exec_module(module)
