// Planning shares the ledger; a forecast never changes a balance.
export function planning(b, { money, date, month, today }) {
  const db = b.db;
  const validCategory = id => {
    if (!db.prepare('SELECT id FROM categories WHERE id=?').get(Number(id))) throw Error('Elegí una categoría existente.');
    return Number(id);
  };
  function setGoal(p) {
    const id = validCategory(p.category_id), amount = money(p.amount);
    if (amount <= 0) throw Error('La meta debe ser mayor que cero.');
    date(p.due_date);
    db.prepare('INSERT INTO goals VALUES (?,?,?) ON CONFLICT(category_id) DO UPDATE SET amount=excluded.amount,due_date=excluded.due_date').run(id, amount, p.due_date);
    return { category_id: id, amount, due_date: p.due_date };
  }
  function listGoals(m = today().slice(0, 7)) {
    month(m);
    const s = b.snapshot(m);
    return db.prepare('SELECT * FROM goals ORDER BY due_date').all().map(g => {
      const c = s.categories.find(c => c.id === g.category_id);
      const saved = Math.max(0, c.available), remaining = Math.max(0, g.amount - saved);
      const [y, mo] = m.split('-').map(Number), [dy, dm] = g.due_date.split('-').map(Number);
      return { ...g, name: c.name, saved, remaining, monthly: Math.ceil(remaining / Math.max(1, (dy-y)*12+dm-mo+1)), progress: Math.min(100, Math.floor(saved/g.amount*100)) };
    });
  }
  function createRecurring(p) {
    if (!b.snapshot().accounts.some(a => a.id === Number(p.account_id))) throw Error('Elegí una cuenta existente.');
    const amount = money(p.amount);
    if (!amount) throw Error('El importe no puede ser cero.');
    const cat = p.category_id ? validCategory(p.category_id) : null;
    if (amount < 0 && !cat) throw Error('Elegí una categoría para el gasto.');
    if (typeof p.payee !== 'string' || !p.payee.trim() || p.payee.length > 160) throw Error('Ingresá un beneficiario de hasta 160 caracteres.');
    date(p.next_date);
    if (!['weekly','monthly','yearly'].includes(p.frequency)) throw Error('Frecuencia inválida.');
    return Number(db.prepare('INSERT INTO recurring(account_id,category_id,payee,amount,next_date,frequency,anchor_day) VALUES (?,?,?,?,?,?,?)').run(Number(p.account_id),cat,p.payee.trim(),amount,p.next_date,p.frequency,Number(p.next_date.slice(8))).lastInsertRowid);
  }
  const listRecurring = () => db.prepare('SELECT r.*,a.name account_name,c.name category_name FROM recurring r JOIN accounts a ON a.id=r.account_id LEFT JOIN categories c ON c.id=r.category_id ORDER BY r.active DESC,r.next_date,r.id').all();
  function postRecurring(p) {
    date(p.due_date);
    return db.transaction(() => {
      const r = db.prepare('SELECT * FROM recurring WHERE id=?').get(Number(p.id));
      if (!r || !r.active) throw Error('El movimiento recurrente no está activo.');
      if (r.next_date !== p.due_date) throw Error('Ese vencimiento ya cambió. Actualizá la lista antes de registrar.');
      const id = b.addTransaction({ ...r, date: p.due_date });
      db.prepare('INSERT INTO recurring_occurrences VALUES (?,?,?)').run(r.id,p.due_date,id);
      const [y,m,d] = r.next_date.split('-').map(Number);
      let next;
      if (r.frequency === 'weekly') next = new Date(Date.UTC(y,m-1,d+7));
      else {
        const target = new Date(Date.UTC(y+(r.frequency==='yearly'?1:0),m-1+(r.frequency==='monthly'?1:0),1));
        const last = new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate();
        next = new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth(),Math.min(r.anchor_day,last)));
      }
      const next_date = date(next.toISOString().slice(0,10));
      db.prepare('UPDATE recurring SET next_date=? WHERE id=?').run(next_date,r.id);
      return { transaction_id: id, next_date };
    })();
  }
  function toggleRecurring(p) {
    if (typeof p.active !== 'boolean') throw Error('active debe ser true o false.');
    if (!db.prepare('UPDATE recurring SET active=? WHERE id=?').run(Number(p.active),Number(p.id)).changes) throw Error('Movimiento recurrente inexistente.');
    return { id:Number(p.id), active:p.active };
  }
  function overview(m = today().slice(0,7)) {
    const s = b.snapshot(m);
    const normal = s.transactions.filter(t => t.kind === 'normal');
    const income = normal.filter(t=>t.amount>0 && !t.category_id).reduce((n,t)=>n+t.amount,0);
    const spending = -normal.filter(t=>t.category_id).reduce((n,t)=>n+t.amount,0);
    return { month:m, income, spending, net:income-spending, ready:s.ready, balance:s.accounts.reduce((n,a)=>n+a.balance,0), overspent:s.categories.filter(c=>c.available<0), upcoming:listRecurring().filter(r=>r.active), goals:listGoals(m), recent:s.transactions.slice(0,6) };
  }
  function cube(p) {
    date(p.from); date(p.to);
    if(p.from>p.to) throw Error('La fecha inicial debe ser anterior a la final.');
    const dimensions = {month:"substr(t.date,1,7)",day:'t.date',category:"COALESCE(c.name,'Ingreso sin categoría')",account:'a.name',payee:'t.payee'};
    const keys = p.dimensions || ['category'];
    if(!Array.isArray(keys) || !keys.length || keys.length>3 || new Set(keys).size!==keys.length || keys.some(k=>!Object.hasOwn(dimensions,k))) throw Error('Elegí entre una y tres dimensiones: month, day, category, account, payee.');
    const fields = keys.map(k=>`${dimensions[k]} AS ${k}`).join(',');
    // A single fact table: joins are many-to-one, so amounts cannot multiply.
    const rows = db.prepare(`SELECT ${fields},COUNT(*) count,
      SUM(CASE WHEN t.category_id IS NULL THEN t.amount ELSE 0 END) income,
      SUM(CASE WHEN t.category_id IS NOT NULL THEN -t.amount ELSE 0 END) spending,
      SUM(t.amount) net FROM transactions t JOIN accounts a ON a.id=t.account_id
      LEFT JOIN categories c ON c.id=t.category_id WHERE t.kind='normal' AND t.date BETWEEN ? AND ?
      GROUP BY ${keys.map(k=>k==='category'?'c.id':k==='account'?'a.id':dimensions[k]).join(',')} ORDER BY ${keys.join(',')}`).all(p.from,p.to);
    const totals = rows.reduce((t,r)=>({count:t.count+r.count,income:t.income+r.income,spending:t.spending+r.spending,net:t.net+r.net}),{count:0,income:0,spending:0,net:0});
    return {from:p.from,to:p.to,dimensions:keys,rows,totals};
  }
  return { setGoal, listGoals, createRecurring, listRecurring, postRecurring, toggleRecurring, overview, cube,
    removeGoal: p => { validCategory(p.category_id); db.prepare('DELETE FROM goals WHERE category_id=?').run(Number(p.category_id)); return { removed:true }; },
    searchTransactions: p => {
      const s = b.snapshot(p.month);
      const q = String(p.query || '').toLocaleLowerCase('es');
      return s.transactions.filter(t => (!p.account_id || t.account_id===Number(p.account_id)) && (!p.category_id || t.category_id===Number(p.category_id)) && (!q || `${t.payee} ${t.account_name} ${t.category_name||''}`.toLocaleLowerCase('es').includes(q)));
    }
  };
}
