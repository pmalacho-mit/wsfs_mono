import sys
import os

def add_to_sys_path(path: str):
  if path not in sys.path:
      sys.path.insert(0, path)
  else:
      # Move the existing path to the front
      sys.path.remove(path)
      sys.path.insert(0, path)

  init = os.path.join(path, "__init__.py")
  if not os.path.exists(init):
    with open(init, "w") as _f:
        pass
