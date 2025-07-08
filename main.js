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

const _registry = {}; // uriUser - {uriUser, [contacts: uri - {remote, expiresAt, contact}], [contactsOrdered], {knownAs}}
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

    if (req.headers.contact === "*") {
        req.headers.contact = _getActualContacts(uriUser);
    }

    for (let i in req.headers.contact) {
        const uri = req.headers.contact[i].uri;
        if (entry.contacts[uri]) {
            entry.contacts[uri].contact = req.headers.contact[i];
            //Object.assign(entry.contacts[uri], req.headers.contact[i]);
        } else {
            entry.contacts[uri] = {
                contact: req.headers.contact[i]
            };
            entry.contactsOrdered.push(entry.contacts[uri]);
            //entry.contacts[uri] = req.headers.contact[i];
        }

        _contactUris[uri] = entry.contacts[uri];  // not used yet

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
        const q = (contact2.contact.params.q ? +contact2.contact.params.q : 0) - (contact1.contact.params.q ? +contact1.contact.params.q : 0);
        if (q === 0) { // equal
            return contact2.expiresAt - contact1.expiresAt;
        }
        return q;
    });

    console.debug("REGISTER OK", req.headers.to.uri);

    return entry;
}

// remove expired contacts
setInterval(() => {
    const tim = Date.now();
    let count = 0;
    for (const entry of _registry) {
        let i = entry.contactsOrdered.length;
        while (i--) {
            const contactInfo = entry.contactsOrdered[i];
            if (contactInfo.expiresAt < tim) {
                entry.contactsOrdered.splice(i, 1)[0];
                delete entry.contacts[contactInfo.contact.uri];
                count++;
            }
        }
    }
    console.debug(`Removed ${count} expired registrations`);
}, 1000 * 60 * 60); // every hour

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
    const res = sip.makeResponse(req, 200, 'OK');
    //res.headers.contact = _getActualContacts(reg.uriUser);
    proxy.send(res);
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
    if (!limit) {
        limit = 65535; // TODO: reengineer how specify no limit
    }
    const tim = Date.now();
    const ret = [];
    const entry = _registry[uriUser];
    if (entry) {
        const contacts = entry.contactsOrdered;
        for (const contactInfo of contacts) {
            if (contactInfo.expiresAt < tim) {
                ret.push(contactInfo.contact);
                if (ret.length >= limit) {
                    break;
                }
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
        delete req.reason;
        delete req.status;
        if (req.method === 'REGISTER') {
            _register(req, remote);
        } else {
            _route(req);
        }
    }

});

console.log(`Started sip proxy server on ${config.host}:${config.port}\n\n\n`);

