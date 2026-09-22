// --- CONFIGURATION ---
// If empty, it attempts to use the current page's origin (good for "Host It There" method)
let API_BASE = ""; 

//[v2.0] define types of data returned by the OTBR or for internal use.
const NETWORK_DIAG = "getNetworkDiag";
const GET_NODE = "getNode";  //uses GET on legacy endpoint `/node`.
const NEIGHBOR = "netDiagNeighborData"; //getNetworkDiag's per Neighbor data. For internal use.


// --- VISUALIZATION SETUP ---
const VIS_ROUTER_NODE_SIZE = 15;
const VIS_END_DEVICE_NODE_SIZE = 15;

const nodes = new vis.DataSet([]);
const edges = new vis.DataSet([]);
const container = document.getElementById('mynetwork');
const data = { nodes: nodes, edges: edges };
const options = {
    nodes: {
        shape: 'hexagon',
        size: VIS_ROUTER_NODE_SIZE,
        font: { size: 14, face: 'monospace', background: 'transparent' },
        borderWidth: 2,
        shadow: true
    },
    edges: {
        width: 2,
        smooth: false,
        font: { align: 'top', size: 10, background: 'transparent', strokeWidth: 0 }
    },
    physics: {
        stabilization: false,
        barnesHut: { 
            gravitationalConstant: -10000, 
            springConstant: 0.04, 
            springLength: 100,
            damping: 0.09
        }
    }
};
const network = new vis.Network(container, data, options);

// --- EVENT LISTENERS ---
document.getElementById('btnStart').addEventListener('click', startDiscovery);
document.getElementById('btnExport').addEventListener('click', exportData);
// Import Logic
const modal = document.getElementById('importModal');
//[v2.0] changing Import CLI to Import JSON (For Future Use)
document.getElementById('btnImport').addEventListener('click', () => modal.style.display = 'flex');
document.getElementById('btnCancelImport').addEventListener('click', () => modal.style.display = 'none');
//document.getElementById('btnParseImport').addEventListener('click', parseCliInput);

// Add listener for Link Filter
document.getElementById('linkFilter').addEventListener('change', updateLinkVisibility);

// --- STATE ---
const visitedNodes = new Set();
const nodeQueue = [];
let isScanning = false;
let currentLeaderId = null;

// Manual Name Mapping: { "ext_address_hex": "Friendly Name" }
let deviceNames = {
    "b2c9a2836317bc63": "Border Router",
    // Add your devices here, e.g.:
    // "f4ce36...": "Living Room Light"
};

// Try to load external names file if valid
fetch('device_names.json')
    .then(r => r.json())
    .then(data => { deviceNames = { ...deviceNames, ...data }; })
    .catch(e => console.log("No external device_names.json found, using defaults."));

// --- CLICK INTERACTION ---
network.on("click", function (params) {
    if (params.nodes.length > 0) {
        const nodeId = params.nodes[0];
        const node = nodes.get(nodeId);

        //[v2.0] original code inserted parsed ipv6 addresses into rawData as "ip6" data.
        //  "ip6" data has been moved to its own node dB element "ip6".  So update the following:
        let ip6Html = '';
//      if (node.rawData && node.rawData.ip6 && Array.isArray(node.rawData.ip6)) {
//          ip6Html = '<strong>IPv6 Addresses:</strong><br><div style="font-size:10px; margin-left:10px;">' + 
//                    node.rawData.ip6.join('<br>') + '</div><br>';
//      }
        if (node.ip6 && Array.isArray(node.ip6)) {
            ip6Html = '<strong>IPv6 Addresses:</strong><br><div style="font-size:10px; margin-left:10px;">' + 
                      node.ip6.join('<br>') + '</div><br>';
        }
      //[v2.0] original code inserted the extended Address into the 
      //    rawData as "extAddress" and into the Title; both used for storage.
      //    "extAddress has been moved to its own node dB element "extAddress". So update the following: 
      //const extAddr = (node.rawData && node.rawData.extAddress) ? node.rawData.extAddress : (node.title ? node.title.split('\n')[0] : 'Unknown');
        const extAddr = (node.extAddress) ? node.extAddress : 'Unknown';

        //[v2.0] Various tweaks to the displayed "Node Details'.
        const detailHtml = `
            <strong>RLOC16:</strong> ${node.id}<br>
            <strong>Extended Address:</strong> ${extAddr}<br>
            <strong>Thread Version:</strong> ${node.threadVer}<br>
            ${ip6Html}
            <strong>Role:</strong> ${node.nodeRole}<br>
            <strong>Raw Info:</strong> <pre style="font-size:10px">${JSON.stringify(node.rawData, null, 2)}</pre>
        `;
          //<strong>Role:</strong> ${node.group}<br>
        document.getElementById('details-panel').innerHTML = detailHtml;
    }
});

// --- LOGGING ---
// [v2.0] AI recommended tweak to function log
function log(msg) {
    const win = document.getElementById('log-window');
    const time = new Date().toLocaleTimeString().split(' ')[0];
    
    // insertAdjacentHTML parses the string without affecting the rest of the DOM
  //win.innerHTML += `<div class="log-entry"><span class="log-time">[${time}]</span> ${msg}</div>`;
    win.insertAdjacentHTML('beforeend', `<div class="log-entry"><span class="log-time">[${time}]</span> ${msg}</div>`);
    win.scrollTop = win.scrollHeight;
}

// [v2.0] adding way to log a single character (or two) within a log entry.
function logSingle(char) {
    const win = document.getElementById('log-window');
    
    // Find the very last log entry element inside the window
    const lastEntry = win.querySelector('.log-entry:last-child');
    
    if (lastEntry) {
        // Append the dot to the text of the existing line
        lastEntry.appendChild(document.createTextNode(`${char}`));
    } else {
        // Fallback: Create a new line if the log window is empty
        log(`${char}`); 
    }
    
    win.scrollTop = win.scrollHeight;
}

// --- UPDATED DISCOVERY ENGINE ---
async function startDiscovery() {
    // [v2.0] removing import cli function. 
    //   Replacing it with "enter number of Thread nodes". 
    //   Number of Thread nodes is the (approximate) number of nodes in the Thread network.
    //   This is used by the updateDeviceCollectionTask as the "deviceCount".
    const inputNumNodes = document.getElementById('numNodes').value;
    if (inputNumNodes) {
        expectedNumNodes = parseInt(inputNumNodes);
        log(`Expected number of nodes is ${expectedNumNodes}`);
    } else {
        expectedNumNodes = 20;
        log(`Number of nodes not provided. Using default of 20`);
    }

    // Set API URL from input if provided
    const inputUrl = document.getElementById('apiUrl').value;
    if (inputUrl) {
        API_BASE = inputUrl.replace(/\/$/, ""); 
    } else if (!API_BASE) {
        // Default to the known OTBR address if input is empty and no base set
        //[v2.0] changing default OTBR address to homeassistant.local
      //API_BASE = "http://192.168.1.50:8081";
        API_BASE = "http://homeassistant.local:8081";
        log(`No URL provided. Using default: ${API_BASE}`);
    }

    if (isScanning) return;
    isScanning = true;
    document.getElementById('btnStart').disabled = true;
    
    nodes.clear();
    edges.clear();
    visitedNodes.clear();
    nodeQueue.length = 0;

    log("Starting Discovery...");

    //[v2.0] adding updateDeviceCollectionTask
    // This is a REST "/api/action" to update the device collection on the OTBR server.
    // It discovers the Thread network and adds or updates any responding 
    // attached devices in the /api/devices collection
    // This action does not require a destination or eui64, as it updates the entire collection.
    
    try {
        // Step 0: Create Async Task via /api/actions
        //   for updateDeviceColletionTask
        const payload = {
            "data": [{
                "type": "updateDeviceCollectionTask",
                "attributes": {
                    "maxAge": 30,
                    "maxRetries": 5,
                  //"deviceCount": 15,
                    "deviceCount": expectedNumNodes,
                    "timeout": 93
                    }
                }
            ]
        };

        
        console.log("Sending Payload:", JSON.stringify(payload));
        log(`Requesting Update Device Collection Task\n (This can take a few minutes) `);

        const taskResp = await fetch(`${API_BASE}/api/actions`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/vnd.api+json',
                'Accept': 'application/vnd.api+json'
            },
            body: JSON.stringify(payload)
        });

        if (!taskResp.ok) {
            const errorText = await taskResp.text();
            console.error("API Error Payload:", errorText); 
            throw new Error(`Task creation failed (${taskResp.status}): ${errorText}`);
        }
        const taskJson = await taskResp.json();
        console.log("updateDevCollection Resp:", JSON.stringify(taskJson));
        
        // Extract Action ID (Note: updateDevCollection does not return a Relationship/Result ID)
        let actionId;
        if (taskJson.data && Array.isArray(taskJson.data)) {
                actionId = taskJson.data[0].id;
        } else if (taskJson.data) {
                actionId = taskJson.data.id;
        }
        console.log("Action ID:", actionId);
        
        if (!actionId) throw new Error("Could not parse Action ID from response");

        // Poll the Action until 'completed'
        const resultId = await pollAction(actionId, maxAttempts=93, expect_result_id=false);
        if (resultId) {
            log(`Update Device Collection Task Completed`);
        } else {
            log(`Update Device Collection Task Failed to Complete`);
        }
        
    } catch (e) {
        log(`Error updating: ${e.message}`);
    }

    // Step 1: Get Starting (aka Root) Node Data using GET "/node".
    try {
        //[vX.Y] FUTURE, USE more modern "/api/devices" instead of "/node".

        const selfResp = await fetch(`${API_BASE}/node`, {
            headers: { 'Accept': 'application/json' }
        });
        if (!selfResp.ok) throw new Error(`HTTP Error: ${selfResp.status}`);
        
        const selfData = await selfResp.json();
        
        // --- FIX IS HERE: Handle Flat vs Wrapped JSON ---
        // If 'result' exists, use it. Otherwise, use the root object.
        const rootData = selfData.result ? selfData.result : selfData; 
       
        //[v2.0] move the Leader Data handling to addNodeToGraph 
        //  for get "/node" processing 
//      // Capture Leader ID from local node data
//      if (rootData.leaderData) {
//          currentLeaderId = rootData.leaderData.leaderRouterId;
//          log(`Network Leader Router ID: ${currentLeaderId}`);
//      }

        const startRloc = rootData.rloc16;
        // FIX: If rootData.extAddress is missing in /node (sometimes it is), try to fetch /api/diagnostics/ for self first
        // But usually /node has it. If not, use 'undefined' which triggers fallback logic.
        const startExt = rootData.extAddress; 

        if (!startRloc) {
                throw new Error("Could not find RLOC16 in API response. Check console.");
        }
        
        log(`Border Router found at ${startRloc} (${startExt || 'Unknown Ext'})`);
        
        // Add Root BR to map
        //[v2.0] add "type" of query data to being passed in.
      //addNodeToGraph(startRloc, { ...rootData, extAddress: startExt }, "Border Router");
        addNodeToGraph(startRloc, { ...rootData, extAddress: startExt }, GET_NODE, "Border Router");
        
        // Start Crawl with Object containing both RLOC and ExtAddress
        // ExtAddress is preferred for API destination
        nodeQueue.push({ rloc: startRloc, ext: startExt });
        processQueue();

    } catch (e) {
        console.error(e); // Log full error to browser console
        log(`Error: ${e.message}`);
        isScanning = false;
        document.getElementById('btnStart').disabled = false;
    }
}

async function processQueue() {
    if (nodeQueue.length === 0) {
        log("Discovery complete.");
        isScanning = false;
        document.getElementById('btnStart').disabled = false;
        return;
    }

    const currentNode = nodeQueue.shift();
    const currentRloc = currentNode.rloc;
    const currentExt = currentNode.ext;
    
    // Use Extended Address for unique visitation check if available, otherwise RLOC
    const visitKey = currentExt || currentRloc;

    if (visitedNodes.has(visitKey)) {
        processQueue();
        return;
    }
    visitedNodes.add(visitKey);

  //[v2.0] This log is redundant.
  //log(`Probing node ${currentRloc} (${currentExt || '?'})...`);

    try {
        // Step 2: Create Async Task via /api/actions for action type getNetworkDiagnosticTask.
        // Try using ExtAddress as destination, fallback to RLOC
        // [v2.0] - add "children". 
        // [v2.0] -add childIpv6Addresses, and several others.
        // [vX.Y] - Maybe change timeout to 10 (number of count downs (polls) waiting for completion).
        const payload = {
            data: [{
                type: "getNetworkDiagnosticTask",
                attributes: {
                    destination: currentExt || currentRloc,
                    types: ["routerNeighbors", 
                            "childTable",
                            "children", 
                            "rloc16", 
                            "extAddress", 
                            "ipv6Addresses", 
                            "childIpv6Addresses",
                          //"version", GitHub docs not up-to-date. throws a "Unprocessable Content", "status": 422
                            "threadVersion",
                            "vendorName",
                            "vendorModel",
                            "vendorSwVersion",
                            "threadStackVersion",
                          //"route", //more like a network link-cost dB, not a route table.
                          //"networkData", //This will be very parse intensive.
                            "connectivity"
                           ],
                    timeout: 5
                }
            }]
        };
        
        console.log("Sending Payload:", JSON.stringify(payload));
        //[v2.0]  
      //log(`Get Net Diags-node: RLOC=${currentRloc}\n ExtAddress=${currentExt || '?'}...`);
        log(`Get Net Diags-node: ExtAddress=${currentExt || '?'}\nRLOC=${currentRloc}\n...`);
      //log(`Probing ${currentRloc} (Ext: ${currentExt}) with destination: ${currentExt || currentRloc}`);

        const taskResp = await fetch(`${API_BASE}/api/actions`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/vnd.api+json',
                'Accept': 'application/vnd.api+json'
            },
            body: JSON.stringify(payload)
        });

        if (!taskResp.ok) {
            const errorText = await taskResp.text();
            console.error("API Error Payload:", errorText); 
            throw new Error(`Task creation failed (${taskResp.status}): ${errorText}`);
        }
        
        const taskJson = await taskResp.json();
        
        // Extract Action ID (not the Result ID yet)
        let actionId;
        if (taskJson.data && Array.isArray(taskJson.data)) {
                actionId = taskJson.data[0].id;
        } else if (taskJson.data) {
                actionId = taskJson.data.id;
        }
        
        if (!actionId) throw new Error("Could not parse Action ID from response");

        // Poll the Action until 'completed'
        const resultId = await pollAction(actionId);
        
        if (resultId) {
            // Fetch the final Diagnostic Report
            const reportResp = await fetch(`${API_BASE}/api/diagnostics/${resultId}`, {
                headers: { 'Accept': 'application/vnd.api+json' }
            });
            const reportJson = await reportResp.json();
            
            // Extract attributes from report
            // result data usually looks like { data: [ { attributes: ... } ] } or { data: { attributes: ... } }
            const reportData = Array.isArray(reportJson.data) ? reportJson.data[0] : reportJson.data;

            //[v2.0] add data_type parameter to pass in to function.
            updateGraph(reportData.attributes, NETWORK_DIAG);

            //[v2.0]
            log(`NetDiag done: ${currentRloc}`);
          //log(`Scanned ${currentRloc}`);

        } else {
            log(`Failed to get data for ${currentRloc}`);
        }

    } catch (e) {
        log(`Error probing ${currentRloc}: ${e.message}`);
    }

    // Throttle requests slightly
    setTimeout(processQueue, 300);
}

//[v2.0] enhances the pollAction() so that updateDeviceCollection can use too.
//async function pollAction(actionId) {
async function pollAction(actionId, maxAttempts=15, expect_result_id=true) {
    let attempts = 0;
  //[v2.0] add param for maxAttempts for use with updateDeviceCollection so it will have time to complete (default is 93s)
  //[v2.0] add param expect_result_id which for updateDeviceCollection is false as it does not return a relationship/result-id.
  //const maxAttempts = 15;
  //const maxAttempts = 93;

    let dotCount = 0;
    while (attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, 1000)); // Wait 1 sec
        
        logSingle('.'); //[v2.0] adder
        dotCount++; // Increment the counter

        if (dotCount === 15) {
          logSingle('\n');
          dotCount = 0;        
        }

        const statusResp = await fetch(`${API_BASE}/api/actions/${actionId}`, {
            headers: { 'Accept': 'application/vnd.api+json' }
        });
        const statusJson = await statusResp.json();
        
        const actionData = Array.isArray(statusJson.data) ? statusJson.data[0] : statusJson.data;
        const status = actionData.attributes.status;
        
        // Debug Log Status
        console.log(`Polling ${actionId}: ${status}`, actionData);

        if (status === 'completed') {
            //[v2.0] adder for UpdateCollectorTask which does not expect result ID
            if (expect_result_id ) {
                // FIX: Robustly find the result ID.
            
                // 1. Check standard 'result' relationship
                const rels = actionData.relationships;
                if (rels) {
                    if (rels.result && rels.result.data) return rels.result.data.id;
                    
                    // 2. Scan ALL relationships for something that looks like a diagnostic result
                    for (const key in rels) {
                        const r = rels[key];
                        if (r.data && r.data.id && (r.data.type || '').toLowerCase().includes('diagnostic')) {
                            // console.log(`Found Result ID in relationship: ${key}`);
                            return r.data.id;
                        }
                    }
                }
    
                // 3. Check 'included' array for diagnostic objects
                if (statusJson.included && Array.isArray(statusJson.included)) {
                    // Find any included item with 'diagnostic' in its type
                    const diag = statusJson.included.find(i => (i.type || '').toLowerCase().includes('diagnostic'));
                    if (diag) {
                        // console.log(`Found Result ID in included: ${diag.type}`);
                        return diag.id;
                    }
                }
                
                console.error("Action completed but no Result ID found.", actionData);
                return null;
            } else {
                return status;
            }
        }
        if (status === 'failed' || status === 'stopped') {
            return null;
        }
        attempts++;
    }
    return null; // Timeout
}

//[v2.0] add "data_type" to indicate what kind of query data is to be processed
function addNodeToGraph(rloc, data, data_type, role, startPos = null) {
    if (!rloc) return;
    const rawData = data || {};

  //log(`addNodeToGraph ${data_type}`); //[v2.0] debug.

  //[v2.0] note: extended address is available in all the queried data_type(s) being
  //  handled here, so no real need to check data_type.
    const ext = rawData.extAddress;
    
    let label = rloc;
    if (ext && deviceNames[ext]) {
            label = `${deviceNames[ext]}\n(${rloc})`;
    }


    if (!nodes.get(rloc)) {
        //[v2.0] notes: This part of the code creates nodes when: 
        //  1) handling GET node for the root OTBR, 
        //  2) adding a neighbor (from iteraing neighbor table) 
        //     as placeholder node until the node is queried directly.

        // Determine default color based on role
        let color = role === 'Border Router' ? '#ff9900' : '#97C2FC'; // Default Blue

        let nodeOptRawData = rawData;

        //[v2.0] moved the leader data processing for GET /node to here.
        if (data_type === GET_NODE) {
          //log(`processing GET_NODE`); //[v2.0] debug
            // Capture Leader ID from local node data
            if (rawData.leaderData) {
                currentLeaderId = rawData.leaderData.leaderRouterId;
              //log(`Network Leader Router ID: ${currentLeaderId}`); //[v2.0] debug
            } else {
              //log(`Not Network Leader`); //[v2.0] debug
            }
            // add to node dB's "rawData" the raw return data value starting with keyname of "getNodeData"
            nodeOptRawData = {getNodeData:rawData};
        } else if (data_type === NEIGHBOR) {
            //[v2.0] Here we are created a placeholder node representing the neighbor.
            //       so won't add any queried return data at this point (will be directly queried later).
            nodeOptRawData = { };
        }
        // Check if this node is the Leader
        if (currentLeaderId !== null) {
            // RLOC16 is 0xRR00. Router ID is top 6 bits.
            const rId = parseInt(rloc, 16) >> 10;
            if (rId === currentLeaderId) {
                color = '#800080'; // Purple for Leader
              //role = `Leader (Router ${rId})`;
                role = `Leader`;
            }
        }

        //[v2.0] add this as a parameter on its own in the node dB. Filled in later via network diag
        let ip6Data = { };

        //[v2.0] seems redundant so removing
        // Use supplied role color if specific role string matched
      //if (role.includes('Leader')) color = '#800080';

        //[v2.0] remove RLOC from title. Its already in the Label.
      //let title = `Ext: ${ext || '??'}\nRLOC: ${rloc}\nRole: ${role}`;
        let title = `Ext: ${ext || '??'}\nRole: ${role}`;

      //[v2.0] will add ip6 addresses later on when doing getNetworkDiag
      //if (rawData.ip6) title += `\nIPv6: ${rawData.ip6.join('\n      ')}`;

        //[v2.0] add ip6, extAddress, nodeRole, Thread version as standalone parameters in the node dB
        const nodeOpts = {
            id: rloc,
            label: label,
            title: title,
            group: role,
            color: color,
            rawData: nodeOptRawData,
            ip6: ip6Data,
            extAddress: ext,
            nodeRole: '',
            threadVer: ''
        };

        if (startPos) {
            nodeOpts.x = startPos.x;
            nodeOpts.y = startPos.y;
        }

        nodes.add(nodeOpts);
    } else {
        //[v2.0] note: Here the node already exists in the dB, but
        //  we now have more data for this node from getNetworkDiagnostics to fill in.

        // Update existing node if we now have more info (e.g. valid Ext Address)
        const node = nodes.get(rloc);

        // Check for Leader status update if not set
        // [v2.0] note: this code never hits.  It is done above during node creation time.
        if (currentLeaderId !== null && node.group && !node.group.startsWith('Leader')) {
                const rId = parseInt(rloc, 16) >> 10;
                if (rId === currentLeaderId) {
                    nodes.update({
                        id: rloc,
                        group: `Leader (Router ${rId})`,
                        color: '#800080',
       //               title: (node.title || '').replace(/Role: .*/, `Role: Leader (Router ${rId})`)
                    });
                    //[v2.0]
                    log(`Updating Leader ${rloc}`); 
                }
        }
        

        const currentRawData = node.rawData || {};
        // If we didn't have extAddress before but do now, update
        let needsUpdate = false;
        let updates = { id: rloc };

        //[v2.0] seems without the following, the node's color changes unknowingly
        updates.color = node.color
        updates.group = node.group

      //[v2.0] add: get the title
        updates.title = node.title

      //[v2.0] Since addNodeToGraph can process data from different query types,
      //  put in a check for which kind of query data is to be processed
      //if (!currentRawData.extAddress && rawData.extAddress) {
        if (data_type === NETWORK_DIAG) {
            const newExt = rawData.extAddress;
            let newLabel = rloc;
            if (newExt && deviceNames[newExt]) {
               newLabel = `${deviceNames[newExt]}\n(${rloc})`;
            }
            //[v2.0] move IPv6 processing to here.
            if (rawData.ipv6Addresses) {
                ip6Data = rawData.ipv6Addresses;
                updates.ip6 = ip6Data;
                updates.title = (updates.title) + `\nIPv6: ${updates.ip6.join('\n      ')}`;
              //updates.title = (updates.title || node.title) + `\nIPv6: ${updates.ip6.join('\n      ')}`;
              //updates.title = (updates.title || node.title) + `\nIPv6: ${JSON.stringify(ip6Data, null, 2)}`;
              //log(`title: ${updates.title}`);
                needsUpdate = true;
            }
          //log(`getDiag IPv6: ${JSON.stringify(ip6Data, null, 2)}`);//[v2.0] debug
 
            //[v2.0] refine definition of Border Router and Add Primary
            let routerRole = `Router`;
            let isTBR = rawData.isBorderRouter;
            let isPBBR = rawData.isPrimaryBBR;
            let isLeader = rawData.isLeader;
          //log(`isTBR: ${isTBR}`);//[v2.0] debug
          //log(`isPBBR: ${isPBBR}`);//[v2.0] debug
          //log(`isLeader: ${isLeader}`);//[v2.0] debug
            if( isTBR !== null && isTBR) routerRole = `${routerRole}, Border Router`; 
            if( isPBBR !== null && isPBBR) routerRole = `${routerRole}, PrimaryBBR`; 
            if( isLeader !== null && isLeader) routerRole = `${routerRole}, Leader`; 
          //log(`routerRole: ${routerRole}`);
            updates.title = (updates.title || '').replace(/Role: .*/, `Role: ${routerRole}`);
          //updates.title = (node.title || '').replace(/Role: .*/, `Role: ${routerRole}`);
            updates.nodeRole = routerRole;

            updates.label = newLabel;
          //updates.title = (node.title || '').replace('Ext: ??', `Ext: ${newExt}`); // Simple replace
            updates.title = (updates.title || '').replace('Ext: ??', `Ext: ${newExt}`); // Simple replace
            //[v2.0] restructure node.rawData to only contain raw data returned from queries
          //updates.rawData = { ...currentRawData, extAddress: newExt };
          //updates.rawData = rawData;
            updates.rawData = { ...currentRawData, diagData:rawData};
      
          //[v2.0] add Thread Version to node dB. Note version is 1.(x-1). Ex. x=5 is Thread 1.4
            let threadVersion = 'Unknown';
            if (rawData.threadVersion){
                threadVersion = `1.${rawData.threadVersion -1}`;
            } 
            updates.threadVer = threadVersion;

            needsUpdate = true;
        }
        // [v2.0] ip6 data is already provided.
//      // Update IPv6 if provided
//      if (rawData.ip6 && (!currentRawData.ip6 || currentRawData.ip6.length === 0)) {
//           updates.rawData = updates.rawData || { ...currentRawData };
//           updates.rawData.ip6 = rawData.ip6;
//           updates.title = (updates.title || node.title) + `\nIPv6: ${rawData.ip6.join('\n      ')}`;
//           needsUpdate = true;
//           log(`Updating rawData.ip6 `); 
//      }

      //log(`NeedsUpdate ${needsUpdate}`); 
        if (needsUpdate) {
            nodes.update(updates);
        }
    }
}

//[v2.0] removing CLI parser code
// --- CLI IMPORT PARSER ---
//function parseCliInput() {
//    const text = document.getElementById('jsonInput').value;
//}
//[v2.0] start of original CLI parser code
//[v2.0] end of original CLI parser code

function exportData() {
    const data = {
        nodes: nodes.get(),
        edges: edges.get()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], {type: "application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `thread-topo-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
}

function updateLinkVisibility() {
    const minLqi = parseInt(document.getElementById('linkFilter').value);
    const updates = [];
    const allEdges = edges.get();
    
    allEdges.forEach(edge => {
        // Retrieve LQI. If undefined (e.g. child links), treat as high quality (99) to keep visible.
        const lqi = edge.lqi !== undefined ? edge.lqi : 99;
        
        const shouldHide = lqi < minLqi;
        
        // Update check: If visibility OR physics state is wrong, update it.
        // We disable physics for hidden edges so they don't pull nodes together invisibly.
        if (edge.hidden !== shouldHide || edge.physics === shouldHide) {
            updates.push({ 
                id: edge.id, 
                hidden: shouldHide,
                physics: !shouldHide // Physics ON if shown, OFF if hidden
            });
        }
    });

    if (updates.length > 0) {
        edges.update(updates);
    }
}

//[v2.0] add data_type to this function.
function updateGraph(data, data_type) {
    //[v2.0] note: This function is used when queried data for the queried node
    //  also contains a list of neighbors and children nodes.  Currently for getNetworkDiag only.
    //  This queried node is handed to addToGraph()
    //  Each neighbor node is handed to addToGraph() to create a placeholder node.
    //  Each child is handled directly by this routine.

    const rloc = data.rloc16;
  //log(`updateGraph ${data_type}`); //[ver2.0] debug

    //[v2.0] "ipv6AddressList" is no longer available in any queried data so removing it here.
    // Normalize IPv6 list for display
    if (nodes.get(rloc)) {
        node = nodes.get(rloc);
        let updates = { id: rloc };
        const currentRawData = node.rawData || {};
        if (data.ipv6Addresses) {
            //[v2.0] have moved ip6 list to its own parameter in the node dB.
          //updates.rawData = { ...currentRawData, ip6:data.ipv6Addresses};
          //updates.title = (updates.title || node.title) + `\nIPv6: ${updates.rawData.ip6.join('\n      ')}`;
          //nodes.update(updates);
        } 
//        else if (data.ip6AddressList) {
//          updates.rawData = { ...currentRawData, ip6:data.ipv6AddressList};
//          updates.title = (updates.title || node.title) + `\nIPv6: ${updates.rawData.ip6.join('\n      ')}`;
//          nodes.update(updates);
//      }
    }

    //[v2.0] 
    // Normalize IPv6 list for display
//  if (data.ipv6Addresses) {
//      data.ip6 = data.ipv6Addresses;
//  } else if (data.ip6AddressList) {
//      data.ip6 = data.ip6AddressList;
//  }

    addNodeToGraph(rloc, data, data_type, 'Router');

    // Process Neighbors here:

    // [v2.0] note: Router Neighbor TLV (sect 10.11.4.12) was only added in Thread 1.4.
    //   However routers supporting version 1.3 seem to provide it anyway.

    if (data.routerNeighbors) {
        // Pre-calculate positions for purely new nodes to distribute them in a circle
        const newNeighbors = data.routerNeighbors.filter(n => !nodes.get(n.rloc16));
        const parentPositions = network.getPositions([rloc]);
        const parentPos = parentPositions[rloc] || {x: 0, y: 0};
        const distributionRadius = 250; 

        data.routerNeighbors.forEach(n => {
            const neighborRloc = n.rloc16;
            const neighborExt = n.extAddress;

            // [vX.Y] FUTURE: change scheme to use RouteData's LQI instead of computing using link margin
            //        as the former should be more definitive.
            // [v2.0] note: "linkQualityIn" is no longer available in "routerNeighbors" queried data.
            // [v2.0] note: Link Quality computed from Link Margin below is per Thread section 9.4:
            // FIX: Use linkQualityIn if available, else derive from linkMargin
            let lqi = n.linkQualityIn;
            if (lqi === undefined && n.linkMargin !== undefined) {
                const lm = n.linkMargin;
                if (lm > 20) lqi = 3;
                else if (lm > 10) lqi = 2;
                else if (lm > 2) lqi = 1;
                else lqi = 0;
            }
            
            // Ensure neighbor node exists (if not, create a placeholder) so edge can connect
            if (!nodes.get(neighborRloc)) {
                // Calculate start position if this is a new node
                let startPos = null;
                const newIndex = newNeighbors.indexOf(n);
                if (newIndex !== -1) {
                    const angle = (newIndex / newNeighbors.length) * 2 * Math.PI;
                    startPos = {
                        x: parentPos.x + distributionRadius * Math.cos(angle),
                        y: parentPos.y + distributionRadius * Math.sin(angle)
                    };
                }

                //[v2.0] 
                //  add data type parameter NEIGHBOR to designate the queried data
                //  being passed is an entry in the getNetworkDiag neighbor table.
                //  and pass in the neighbor table entry for this node.
              //log(`+ placeholder: ${neighborRloc}`);//[v2.0] debug

                // Use helper to ensure naming and coloring logic is applied immediately
                // even before we probe the node fully.
              //addNodeToGraph(neighborRloc, { extAddress: neighborExt }, 'Router', startPos);
                addNodeToGraph(neighborRloc, n, NEIGHBOR, "Router", startPos);
            }

            //[v2.0] moved the compute physics model parameters to different parts of the code
            //  not only for the case of new neighbors 
            //  but also to update physics for already existing neighbors.

            // Compute Edge ID (sorted to prevent duplicates A->B vs B->A)
            const edgeId = [rloc, neighborRloc].sort().join('-');

            // [v2.0] add lqi=0 as default as gray
          //let color = '#dc3545'; // Default Red
            let color = '#aaa'; // Default Gray
                
            // --- PHYSICS MODEL: Linear Length & Stiffness based on Signal ---
            // Signal Source: Link Margin (preferred) or RSSI
            // Link Margin Range: ~0 (bad) to ~80 (perfect).
            // RSSI Range: -90 (bad) to -20 (perfect).
            
            let signalVal = 0; // Baseline
            if (n.linkMargin !== undefined) {
                signalVal = n.linkMargin; // Higher is better
            } else if (n.averageRssi !== undefined) {
                // Map RSSI (-90 to -20) to approx Link Margin (5 to 75)
                signalVal = Math.max(0, n.averageRssi + 95); 
            } else {
                // Fallback to LQI buckets if no raw data
                signalVal = lqi * 20; 
            }

            // Calculate Length: Signal decaying with square of distance 
            // LinkMargin 60 -> Dist ~180
            // LinkMargin 10 -> Dist ~450
            // Scaled K for "150% longer" (2.5x base). 2000000 * 6.25 = 12500000
            const K = 12500000;
            let length = Math.sqrt(K / Math.max(1, signalVal));
            length = Math.min(2000, Math.max(375, length));

            // Color still based on standard LQI for recognizability
            // [v2.0] add lqi=0 and make it default and color as gray
            if(lqi === 3) color = '#28a745'; 
            else if(lqi === 2) color = '#ffc107'; 
            else if(lqi === 1) color = '#dc3545'; 
            
            // Main Visible Edge
            // Check current filter setting
            const minLqi = parseInt(document.getElementById('linkFilter').value) || 0;
            const isVisible = lqi >= minLqi;
            
            if (!edges.get(edgeId)) {
               //[v2.0] all the physics model stuff was here but moved it above.
               //Case: new neighbor
                edges.add({
                    id: edgeId,
                    from: rloc,
                    to: neighborRloc,
                    lqi: lqi, // Store LQI for filtering
                    label: `LQI:${lqi}\n(${signalVal}dB)`,
                    color: { color: color, highlight: color },
                    width: lqi === 3 ? 3 : 1,
                    length: length,
                    hidden: !isVisible, 
                    physics: isVisible // Only participate in physics if visible
                });
            } else {
                //[v2.0] Update LQI
                //  Case: existing neighbor
                //  LQI is Receive LQI (Rx), so for a given connection between nodes 
                //    there are two Rx LQIs, one from each node.
                //  Two-way Link Quality is the lesser of the two LQIs per Thread spec section 4.5.2.2.
                //  lqi here is the rx LQI from the neighbor n to this node.
                //  However if an edge already exists then the neighbor 
                //  has alread stored rx LQI (in the edge dB) it has seen from this router.
                //  So check if edge's current lqi is greater than the one seen from this router.
                //    If yes, then let's update the edge dB to the lesser lqi,
                //    and likewise all the edge parameters related to the updated lqi.
                edge = edges.get(edgeId);
              //log(`Rx lqi= ${lqi}. Curr lqi=${edge.lqi}`);//[v2.0] debug
                if( lqi < edge.lqi ){
                    curr_lqi = edge.lqi;
                    edges.update({ 
                        id: edgeId, 
                        lqi: lqi,
                        label: `LQI:${lqi}\n(${signalVal}dB)`,
                        color: { color: color, highlight: color },
                        width: lqi === 3 ? 3 : 1,
                        length: length,
                        hidden: !isVisible 
                    });
                    updatedEdge = edges.get(edgeId);
                  //log(`Update lqi ${curr_lqi}->${updatedEdge.lqi}`); //[ver2.0] debug for 2-way LQI
                }
            }

            // Optimization: We check visitedNodes using ExtAddress if possible
            const visitKey = neighborExt || neighborRloc;
            if (!visitedNodes.has(visitKey)) {
                // Check if already in queue
                const alreadyQueued = nodeQueue.some(item => (item.ext && item.ext === neighborExt) || item.rloc === neighborRloc);
                if (!alreadyQueued) {
                        nodeQueue.push({ rloc: neighborRloc, ext: neighborExt });
                }
            }
        });
    }
    
    // Process Children (End Devices)
    // Note: Children are often sleepy end devices (SEDs) and we don't crawl them directly
    // because they don't have neighbors to share. We just display them attached to parent.
    // [v2.0] Updated to add and mainly process "children" getNetworkDiag data instead of "childTable"
    //     as children provide the extension Address which is needed to
    //     lookup a lable in the user configured device lable table.
    //     Note: childTable was added Thread version 1.4 (Section 10.11.4.10).
    //     However, seems even 1.3 routers support childTable.
    // [v2.0] add childIpv6Addresses.  Note: childIpv6Addresses was added in Thread 1.4.
    // [vX.Y] move Children processing to addNodeToGraph() w. new data_type = CHILD
  //if (data.childTable) {
    if (data.children) {
        // Pre-calculate positions for NEW children to distribute them in a separate circle
      //const newChildren = data.childTable.filter(child => {
        const newChildren = data.children.filter(child => {
           //const childId = `${rloc}_child_${child.childId}`;
             const childId = `${child.rloc16}`;
             return !nodes.get(childId);
        });
        const parentPositions = network.getPositions([rloc]);
        const parentPos = parentPositions[rloc] || {x: 0, y: 0};
        const childRadius = 125; 

      //data.childTable.forEach((child, index) => {
        data.children.forEach((child, index) => {
            // Calculate Child RLOC16: Parent RLOC + Child ID
            // Note: This is an approximation. Child ID is usually the last bits.
            // But for display, we might just use a unique ID.
          //const childId = `${rloc}_child_${child.childId}`;
            const childId = `${child.rloc16}`;
            
            // Add Child Node
            if (!nodes.get(childId)) {
                
                let startX = undefined;
                let startY = undefined;
                const newIndex = newChildren.indexOf(child);
                if (newIndex !== -1) {
                     // Interleave or offset angle to avoid direct overlap with router neighbors
                     const angle = (newIndex / newChildren.length) * 2 * Math.PI + (Math.PI / 3); 
                     startX = parentPos.x + childRadius * Math.cos(angle);
                     startY = parentPos.y + childRadius * Math.sin(angle);
                }

                // Try to guess ExtAddress or matching name if we have a way (we don't easily)
                // Unless we looked up the child table elsewhere. 
                // Usually Diagnostics 'childTable' only gives: { childId, timeout, mode, linkQuality }
                // It does NOT give Extended Address. That is why they are missing ExtAddr.

		// [v2.0] use 'children' type instead of 'childTable'                
             // const isSleepy = child.mode && !child.mode.rxOnWhenIdle;
             // const label = `Child ${child.childId}\n${isSleepy ? '(Sleepy)' : ''}`;
                const isSleepy = child && !child.rxOnWhenIdle;
                label = `Child ${child.rloc16}\n${isSleepy ? '(Sleepy)' : ''}`;
                if (child.extAddress && deviceNames[child.extAddress]) {
                     label = `${deviceNames[child.extAddress]}\n(${child.rloc16})`;
                 } 
                //[v2.0] refine child role
                //Thread spec Section 4.4.2 
                //    fullNetworkData= 1 => REED or Router
                //    rxOnWhenIdle= 0 => SED or SSED
                //    DeviceTypeFTD= 1 => FTD 0=> MTD.
                let reedOrFed = ''; 
                if (child.fullNetworkData) reedOrFed += child.fullNetworkData ? 'REED' : "FED" ;
                let childRole = '';
                if (isSleepy !== null) childRole += isSleepy ? 'Sleepy (SED or SSED)' : 'non-Sleepy';
                if (child.deviceTypeFTD !== null) childRole += child.deviceTypeFTD ? ', ${reedOrFed}' : ', MTD';

                //[v2.0] add child ipv6addresses
                let childV6 = [];
                const targetIndex = data.childIpv6Addresses.findIndex(item => item.rloc16 === child.rloc16);
                if (targetIndex !== -1) {
                  //log(`rloc: ${child.rloc16}, Index: ${targetIndex}`);
                    childV6 = data.childIpv6Addresses[targetIndex].ipv6Addresses;
                  //log(`child's IPv6 Addresses: ${childV6}`);
                }

                //[v2.0] add Thread Version to node dB. Note version is 1.x-1
                  let threadVersion = 'Unknown';
                  if (child.threadVersion){
                      threadVersion = `1.${child.threadVersion -1}`;
                  } 

                //[v2.0] process "childTable" for this node. Primarily to get its LQI.
                let childTable = {}
                const targetIndex2 = data.childTable.findIndex(item => item.childId === child.childId);
                if (targetIndex !== -1) {
                  //log(`rloc: ${child.rloc16}, Index: ${targetIndex2}`);
                    childTable = data.childTable[targetIndex2];
                  //log(`child's child Table: ${childTable.linkQuality}`);//[ver2.0] debug
                }

                //[v2.0] add LQI to Edge Lable for Children
                //[v2.0] Note: the computed LQI from children.linkMargin occassionally
                //    does not agree with childTable.linkQuality, 
                //    Thread Section 10.11.4.4 Child Table TLV - Incoming Link Quality
                //     ver 1.3 says for future versions.
                //     ver 1.4 says is the Incoming Link Quality 
                //       as determined from the Parent Router and 0 means unknown.

                  let edgeColor = '#aaa'; // Default Gray
                  const lm = child.linkMargin;
                  let lqi = 0;
                  if (lm !== null){
                      if (lm > 20) lqi = 3;
                      else if (lm > 10) lqi = 2;
                      else if (lm > 2) lqi = 1;
                    //else lqi = 0;

                  }
                  if (childTable.linkQuality !== null){
                      lqi = childTable.linkQuality
                  }
                  if( lqi !== 0 ){
                      edgeColor ='#dc3545'; // Default Red
                      // Color still based on standard LQI for recognizability
                      if(lqi === 3) edgeColor = '#28a745'; 
                      else if(lqi === 2) edgeColor = '#ffc107'; 
                    //log(`lm=${lm}, lqi=${lqi}`); //[ver2.0] debug
                  }

                //[v2.0] add IPv6 Addresses to title and add as node dB parameter. 
                //[v2.0] copy from router the "children" and "childTable" to child node's rawData.
                //  Change Child ID to Ext Address for consistency
                const nodeOpts = {
                    id: childId,
                    label: label,
                  //title: `Child ID: ${child.childId}\nTimeout: ${child.timeout}\nSleepy: ${isSleepy}`,
                  //title: `Child ID: ${child.childId}\nTimeout: ${child.timeout}\nSleepy: ${isSleepy}\nIPv6: ${childV6.join('\n      ')}`,
                    title: `Ext ID: ${child.extAddress || '??'}\nTimeout: ${child.timeout}\nSleepy: ${isSleepy}\nIPv6: ${childV6.join('\n      ')}`,
                    group: 'EndDevice',
                    shape: isSleepy ? 'dot' : 'diamond', 
                    size: VIS_END_DEVICE_NODE_SIZE,
                    color: '#6c757d', 
                  //rawData: child
                  //rawData: {children: child, ip6: data.childIpv6Addresses[targetIndex] },
                  //rawData: {children: child },
                    rawData: {children: child, childTable: childTable },
                    ip6: childV6,
                    extAddress: child.extAddress,
                    nodeRole: childRole,
                    threadVer: threadVersion
                };

                if (startX !== undefined) {
                    nodeOpts.x = startX;
                    nodeOpts.y = startY;
                }
                
                nodes.add(nodeOpts);
                
                // Add Edge to Parent
                //[v2.0] add LQI/Link Margin/color to Edges
                edges.add({
                    from: rloc,
                    to: childId,
                    dashes: true, // Dashed line for child-parent
                    length: 125, // Scaled 2.5x
                  //color: { color: '#aaa' }
                    color: edgeColor,
                    label: `LQI:${lqi}\n(${lm}dB)`,
                });
            }
        });
    }
}
