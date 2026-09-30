export class SerialTaskQueue {
  #tail = Promise.resolve();

  run(task) {
    const current = this.#tail.then(task, task);
    this.#tail = current.catch(() => undefined);
    return current;
  }
}
