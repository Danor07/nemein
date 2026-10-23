export const commands = {
  snapshot:'snapshot', overview:'overview', account:'createAccount', transaction:'addTransaction',
  allocate:'allocate', transfer:'transfer', import:'importCsv', reconcile:'reconcile', reports:'reports',
  backup:'backup', categorize:'categorize', category:'createCategory', group:'createGroup',
  goals:'listGoals', 'goal-set':'setGoal', 'goal-remove':'removeGoal', recurring:'listRecurring',
  'recurring-create':'createRecurring', 'recurring-post':'postRecurring', 'recurring-toggle':'toggleRecurring',
  search:'searchTransactions', cube:'cube'
};
export async function execute(b, command, p = {}) {
  if (!Object.hasOwn(commands,command)) throw Error('Comando desconocido. Usá help para ver los disponibles.');
  if (['snapshot','overview','reports','goals'].includes(command)) return b[commands[command]](p.month);
  if (command==='reconcile') return b.reconcile(p,p.commit===true);
  return b[commands[command]](p);
}
