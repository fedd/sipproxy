const DEFAULTPORT = 5060;
const {Buffer} = require('node:buffer');
const sip = require('sip');
const proxy = require('sip/proxy');
const config = require("./config.json");

const up = config.up;

// normalize config
if (!config.host) {
    config.host = "0.0.0.0";
}
if (!config.port) {
    config.port = DEFAULTPORT;
}
config.logger = {
    error: function (e) {
        console.error("ERROR", e);
    }
};
if (config.verbose) {
    delete config.verbose;
    config.logger.recv = function (msg, remote) {
        console.debug("RECV", msg, remote);
    };
    config.logger.send = function (msg, target) {
        console.debug("SEND", msg, target);
    };
}
if (up) {
    delete config.up;
    if (!up.port) {
        up.port = DEFAULTPORT;
    }
}

const _registry = {};
const _contactUris = {}; // not used yet

function _registerInternal(req, remote, upRemote) {

    const uriUser = sip.parseUri(req.headers.to.uri).user;
    const expiresAt = (req.headers.expires ? +req.headers.expires : 3600000) + Date.now();

    let entry = _registry[uriUser];
    if (!entry) {
        entry = {
            uriUser: uriUser,
            contacts: {},
            contactsOrdered: [],
            knownAs: {}
        };
        _registry[uriUser] = entry;
    }
    if (req.headers.to.name) {
        entry.knownAs[req.headers.to.name] = {};
    }
    if (req.headers.from.name) {
        entry.knownAs[req.headers.to.name] = {};
    }

    for (let i in req.headers.contact) {
        const uri = req.headers.contact[i].uri;
        if (entry.contacts[uri]) {
            Object.assign(entry.contacts[uri], req.headers.contact[i]);
        } else {
            entry.contactsOrdered.push(req.headers.contact[i]);
            entry.contacts[uri] = req.headers.contact[i];
        }

        _contactUris[uri] = entry.contacts[uri];

        entry.contacts[uri].expiresAt = expiresAt;
        entry.contacts[uri].remote = {
            user: remote
        };
        if (upRemote) {
            entry.contacts[uri].remote.up = upRemote;
        }
        if (req.headers.contact[i].name) {
            entry.knownAs[req.headers.contact[i].name] = {};
        }
    }

    // order by "q param and expiration
    entry.contactsOrdered.sort((contact1, contact2) => {
        const q = (contact2.params.q ? +contact2.params.q : 0) - (contact1.params.q ? +contact1.params.q : 0);
        if (q === 0) { // equal
            return contact2.expiresAt - contact1.expiresAt;
        }
        return q;
    });

    console.debug("REGISTER OK", req.headers.to.uri);

    return entry;
}

const _registerUp = function (req, remote) {
    // forward to the real regisrar
    try {
        {
            let uriReq = sip.parseUri(req.uri);
            uriReq.host = up.host;
            uriReq.port = up.port;
            req.uri = sip.stringifyUri(uriReq);
        }

        proxy.send(req, (res, upRemote) => {

            if (+res.status >= 200) {
                // success
                const reg = _registerInternal(req, remote, upRemote);

            } else {
                console.warn("REGISTER FAIL", req, res);
            }

            // default proxy behaviour
            res.headers.via.shift();
            proxy.send(res);
        });
    } catch (err) {
        console.error("REGISTER FAIL", err);
    }
};
const _registerHere = function (req, remote) {
    // we are the registrar ourselves
    const reg = _registerInternal(req, remote);
    proxy.send(sip.makeResponse(req, 200, 'OK'));
};

const _routeUp = function (req) {
    // forward to the real server
    proxy.send(sip.makeResponse(req, 100, 'Trying'));
    const uri = sip.parseUri(req.uri);
    uri.host = up.host;
    uri.port = up.port;
    req.uri = sip.stringifyUri(uri);
    proxy.send(req); // default response back-sending
};

function _getActualContacts(uriUser, limit) {
    const tim = Date.now();
    const ret = [];
    const contacts = _registry[uriUser].contacts;
    for (const uri in contacts) {
        const contact = contacts[uri];
        if (contact.expiresAt < tim) {
            ret.push(contact);
            if (ret.length >= limit) {
                break;
            }
        }
    }
    return ret;
}

function _getActualContact(uriUser) {
    const contacts = _getActualContacts(uriUser, 1);
    if (contacts.length > 0) {
        return contacts[0];
    } else {
        return null;
    }
}

const _routeHere = function (req) {

    // TODO call multiple contacts of a user
    // routing to multiple contacts of a user involves cancelling the calls
    // if one of the phones is picked up. So not implemented yet


    // forward to a registered user
    let uriUser = sip.parseUri(req.uri).user;
    if (uriUser) {
        let goodContact = _getActualContact(uriUser);
        if (goodContact) {
            req.uri = goodContact.uri;
            //proxy.send(sip.makeResponse(req, 100, 'Trying')); 
            proxy.send(req);
            return;
        }
    }

    // otherwise
    proxy.send(sip.makeResponse(req, 404, 'Not Found'));
};

const _register = up ? _registerUp : _registerHere;

const _route = up ? _routeUp : _routeHere;

proxy.start(config, function (req, remote) {

    if (!req.method) {
        console.warn("Rogue response", remote);
    } else {
        if (req.method === 'REGISTER') {
            _register(req, remote);
        } else {
            _route(req);
        }
    }

});

console.log(`Started sip proxy server on ${config.host}:${config.port}\n\n\n`);

