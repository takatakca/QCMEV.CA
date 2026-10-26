#!/usr/bin/env python3
"""Check the dashboard container and proxy using a deterministic backend; does not certify the real MEV service."""
import argparse, subprocess, json, time, urllib.request, urllib.error, uuid, tempfile
from pathlib import Path
parser=argparse.ArgumentParser()
parser.add_argument('--image',default='qcmev-frontend:readiness')
parser.add_argument('--report',default='/tmp/qcmev-proxy-report.json')
args=parser.parse_args()
tag=uuid.uuid4().hex[:8]
logs=Path(tempfile.mkdtemp(prefix='qcmev-container-'))
network='qcmev-readiness-'+tag
backend='qcmev-proxy-backend-'+tag
frontend='qcmev-proxy-frontend-'+tag
def docker(*args):return subprocess.check_output(['docker',*args],text=True).strip()
created=[]
try:
 docker('network','create',network)
 script="require('http').createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({probe:'qcmev-proxy-smoke',path:req.url}));}).listen(3001,'0.0.0.0')"
 docker('run','-d','--name',backend,'--network',network,'--network-alias','qcmev-backend','node:22-alpine','node','-e',script);created.append(backend)
 docker('run','-d','--name',frontend,'--network',network,'-p','127.0.0.1::3000',args.image);created.append(frontend)
 port=docker('port',frontend,'3000/tcp').rsplit(':',1)[1]
 base='http://127.0.0.1:'+port
 for _ in range(100):
  try:
   with urllib.request.urlopen(base+'/login',timeout=2) as r:
    assert r.status==200 and 'Takatak MEV' in r.read().decode();break
  except (OSError,urllib.error.URLError):time.sleep(.2)
 else:raise RuntimeError('frontend did not start')
 checks=['Container /login returns 200 with login content']
 for route in ['/api/health/ready','/api/operators/me']:
  with urllib.request.urlopen(base+route,timeout=5) as r:
   j=json.load(r);assert j=={'probe':'qcmev-proxy-smoke','path':route};checks.append('Internal Docker proxy forwards '+route)
 for route in ['/api/v1/integrations/foodhub/health','/api/mev-simulator/transaction']:
  try:urllib.request.urlopen(urllib.request.Request(base+route,data=b'{}',headers={'Content-Type':'application/json'}),timeout=5)
  except urllib.error.HTTPError as e:assert e.code==404;checks.append('Public proxy does not expose '+route)
  else:raise AssertionError('private route was proxied')
 report={'ok':True,'image':docker('image','inspect',args.image,'--format','{{.Id}}'),'checks':checks,'scope':'Frontend container and internal HTTP proxy only; backend is a deterministic test server, not the full application.'}
 open(args.report,'w').write(json.dumps(report,indent=2)+'\n')
 print(json.dumps(report,indent=2))
finally:
 print('Container startup logs:', logs)
 for name in created:
  with (logs/(name+'.log')).open('w') as f:subprocess.run(['docker','logs',name],stdout=f,stderr=f)
 for name in reversed(created):subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 subprocess.run(['docker','network','rm',network],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
