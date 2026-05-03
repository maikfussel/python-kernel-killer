import os
import time

pid = os.fork()

if pid == 0:
    os._exit(0)

print(f"parent pid={os.getpid()}, zombie child pid={pid}")
print("Check with:")
print(f"ps -o pid,ppid,stat,cmd -p {pid}")

time.sleep(300)