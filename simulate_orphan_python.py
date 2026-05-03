import multiprocessing as mp
import os
import time


def worker():
    print(f"child pid={os.getpid()}, parent pid={os.getppid()}", flush=True)
    while True:
        time.sleep(10)


if __name__ == "__main__":
    p = mp.Process(target=worker)
    p.start()

    print(f"parent pid={os.getpid()}, child pid={p.pid}", flush=True)

    # Abruptly exit parent without joining child.
    os._exit(0)