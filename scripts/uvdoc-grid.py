# Dal modello UVDoc di PaddleX (che restituisce l'immagine già distesa) tiene solo la rete che stima
# la griglia 45×31: la superficie liscia e il campionamento a piena risoluzione li fa l'app (js/dewarp.js).
#   pip install onnx && python3 scripts/uvdoc-grid.py UVDoc.onnx vendor/paddle/uvdoc-grid.onnx
import sys
import onnx
from onnx import helper, TensorProto

src, dst = sys.argv[1], sys.argv[2]
m = onnx.load(src)
g = m.graph
grid = next(n for n in g.node if n.op_type == 'GridSample')
# ingresso della GridSample: Transpose ← Resize ← griglia grezza (2 × 45 × 31)
prod = {o: n for n in g.node for o in n.output}
resize = prod[prod[grid.input[1]].input[0]]
out = resize.input[0]
keep, stack = set(), [out]
while stack:
    n = prod.get(stack.pop())
    if n is None or id(n) in keep:
        continue
    keep.add(id(n))
    stack.extend(n.input)
nodes = [n for n in g.node if id(n) in keep]
used = {i for n in nodes for i in n.input}
del g.node[:]
g.node.extend(nodes)
inits = [i for i in g.initializer if i.name in used]
del g.initializer[:]
g.initializer.extend(inits)
vi = [v for v in g.value_info if v.name in used or v.name == out]
del g.value_info[:]
g.value_info.extend(vi)
del g.output[:]
g.output.append(helper.make_tensor_value_info(out, TensorProto.FLOAT, ['n', 2, 45, 31]))
onnx.checker.check_model(m)
onnx.save(m, dst)
print(f'{dst}: {len(nodes)} nodi')
