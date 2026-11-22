(function(){
  var store = {membres:{}, seances:{}, khassidas:{}, dahiras:{}}, subs = {membres:[], seances:[], khassidas:[], dahiras:[]};
  var noms = [["lamine-dieng","Lamine Dieng",1,0],["ablaye-ndiaye","Ablaye Ndiaye",1,0],["mouhamed-sarr","Mouhamed Sarr",1,0],["seydina-ousmane","Seydina Ousmane",1,0],["mohamed-camara","Mohamed Camara",1,1],["abdou-lahad","Abdou Lahad",1,1],["babacar-sarr","Babacar Sarr",1,1],["xaadim-sylla","Xaadim Sylla",1,1],["issakha","Issakha",1,1],["papa-madior-top","Papa Madior Top",1,1],["cheikh-kebe","Cheikh Kébé",1,1],["mountakha","Mountakha",0,1],["cheikh-bane","Cheikh Bane",0,1],["boucar","Boucar",0,1]];
  noms.forEach(function(n){store.membres[n[0]]={nom:n[1],k1:!!n[2],k2:!!n[3],actif:true,statut:"actif"};}); store.membres["bachir-faye"]={nom:"Bachir Faye",k1:false,k2:true,statut:"pause",motif:"Études à Montréal",depuis:"2026-11-01"};
  store.khassidas["w"]={titre:"Wadieuhtou lilahi hamdane",arabe:"وَجَّهْتُ لِلَّهِ حَمْدًا",page:"khassidas/wadieuhtou/index.html",vers:16,lien:"https://claude.ai/artifact/Tv2vrXSpaLG3gj9hfvY9Uz",versDebut:["وَجَّهْتُ لِلَّهِ","v2","v3","v4","v5","v6","v7","v8"]};store.programmes={"2026-11-26-k1":{horaire:"18h - 21h",lieu:"Local du dahira",khassida:"w",tout:false,de:1,a:8,note:"Écoutez l’enregistrement avant de venir pour avoir la mélodie en tête.\nPensez à envoyer votre Tari si ce n’est pas encore fait.",taris:true}};
  var d=new Date(); var y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,"0");
  function seance(id,date,type,ids,st,extra){var s={date:date,type:type,participants:ids,statuts:{}};ids.forEach(function(i){s.statuts[i]=st[i]||"P";});Object.assign(s,extra||{});store.seances[id]=s;}
  var k1=noms.filter(function(n){return n[2];}).map(function(n){return n[0];}), k2=noms.filter(function(n){return n[3];}).map(function(n){return n[0];});
  seance("a",y+"-"+m+"-19","k1",k1,{"babacar-sarr":"A","cheikh-kebe":"A","papa-madior-top":"A","issakha":"A","lamine-dieng":"R"},{prevenus:{"cheikh-kebe":{motif:"Études",note:"examen"},"papa-madior-top":{motif:"",note:""}},tari:"absents",tariRecu:{"issakha":true},tariDetail:{khassida:"w",de:3,a:8,consigne:"xàjj du dieuwrigne"}});
  seance("b",y+"-"+m+"-20","k2",k2.concat(["bachir-faye"]),{"bachir-faye":"A","babacar-sarr":"A","cheikh-kebe":"A","papa-madior-top":"A","abdou-lahad":"A","cheikh-bane":"R"},{tari:"absents",tariDetail:{khassida:"w",de:1,a:4}});
  seance("k2a","2026-11-13","k2",k2,{"boucar":"R"});
  seance("k2b","2026-11-06","k2",k2,{"cheikh-bane":"A","boucar":"A","mountakha":"A"},{tari:"absents",tariRecu:{"boucar":true},tariDetail:{khassida:"w",de:1,a:2}});
  seance("k2c","2026-10-30","k2",k2,{"cheikh-bane":"A","mountakha":"A"});
  store.evaluations={"mountakha":{prononciation:3,memorisation:3,justesse:3,commentaire:"Très régulier, belle voix posée.",date:"2026-11-15"},"boucar":{prononciation:3,memorisation:2,justesse:3,date:"2026-11-15"},"cheikh-bane":{prononciation:1,memorisation:2,justesse:2,date:"2026-11-10"}};
  store.seances["a"].tariEtat={"babacar-sarr":"recu"};
  store.seances["a"].tariIndividuel={"mohamed-camara":true};
  store.seances["a"].discipline={"lamine-dieng":{tenue:true}};
  store.seances["k2a"].discipline={"boucar":{tenue:true}};
  store.seances["b"].discipline={"boucar":{tenue:true},"mountakha":{coiffure:true}};
  function snap(c){return {docs:Object.keys(store[c]||{}).map(function(id){return {id:id,data:function(){return store[c][id];}};})};}
  var db={doc:function(){return {set:function(){return Promise.resolve();},update:function(){return Promise.resolve();}};},collection:function(c){return {onSnapshot:function(f){(subs[c]=subs[c]||[]).push(f);setTimeout(function(){f(snap(c));},10);return function(){};}};}};
  window.claude={use:function(n){return Promise.resolve(n==="db"?db:n==="user"?{canEdit:function(){return Promise.resolve(true);}}:null);}};
})();
