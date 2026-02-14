
const events = [
    { name: "Match Normal", liveTime: "45'", startDate: "2024-01-01T10:00:00Z" },
    { name: "Match Zero", liveTime: "0'", startDate: "2024-01-01T10:00:00Z" }, // Old date, should be large mins
    { name: "Match Zero Recent", liveTime: "0'", startDate: new Date(Date.now() - 1000*60*5).toISOString() }, // 5 mins ago
    { name: "Match Undefined", liveTime: undefined, startDate: new Date(Date.now() - 1000*60*20).toISOString() }, // 20 mins ago
    { name: "Match Empty", liveTime: "", startDate: new Date(Date.now() - 1000*60*60).toISOString() }, // 60 mins ago
    { name: "Match HT", liveTime: "Descanso", ls: "Descanso" },
    { name: "Match 2nd Half Zero", liveTime: "0'", ls: "2ª parte", startDate: new Date(Date.now() - 1000*60*60).toISOString() }, // 60 mins ago
];

function processEvents(events) {
    return events.map(ev => {
             const status = ev.ls || ""; 
             let cleanTime = ev.liveTime;
             
             // [FALLBACK IMPROVED]
             const isInvalidTime = !cleanTime || cleanTime === "0'" || cleanTime === "" || cleanTime === 0 || cleanTime === "0";
             
             if (isInvalidTime && ev.startDate) {
                 const startedAt = new Date(ev.startDate).getTime();
                 const now = Date.now();
                 let diffMins = Math.floor((now - startedAt) / 60000);
                 
                 if (diffMins < 0) diffMins = 0; 
                 
                 if (diffMins >= 0 && diffMins < 130) {
                     if (status.toLowerCase().includes('2nd') || status.toLowerCase().includes('2t')) {
                         cleanTime = `${Math.max(46, diffMins)}'`;
                     } else if (diffMins === 0) { 
                         cleanTime = "1'"; 
                     } else {
                         cleanTime = `${diffMins}'`;
                     }
                 }
             }

             if (cleanTime && !String(cleanTime).includes("'") && !String(cleanTime).includes(":") && cleanTime !== "HT" && cleanTime !== "Final") {
                cleanTime = `${cleanTime}'`;
             }

             const statusLower = (status || "").toLowerCase();

             if (statusLower.includes('half') || statusLower.includes('descanso') || statusLower.includes('ht') || statusLower.includes('intermedio')) {
                 cleanTime = "HT";
             }
             const isExplicitEnd = statusLower.includes('ended') || statusLower.includes('fin') || statusLower.includes('ft');
             if (isExplicitEnd) {
                 cleanTime = "Final"; 
             }
             
             return {
                 name: ev.name,
                 originalTime: ev.liveTime,
                 finalTime: cleanTime || "0'",
                 startDate: ev.startDate
             };
    });
}

console.log(JSON.stringify(processEvents(events), null, 2));
