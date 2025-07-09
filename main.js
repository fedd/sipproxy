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

function _registerInternal(req, remote, upRemote, failed) {
    const tim = Date.now();
    const uriUser = sip.parseUri(req.headers.to.uri).user;
    const expiresAt = (req.headers.expires ? +req.headers.expires * 1000 : 3600000) + tim;

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

    const modifiedContactUris = [];

    for (let i in req.headers.contact) {
        const uri = req.headers.contact[i].uri;
        if (!uri) {
            failed.push(req.headers.contact[i]);
            continue;
        } else {
            const parsedUri = sip.parseUri(uri);
            if (!parsedUri || !parsedUri.host) {
                failed.push(uri);
                continue;
            }
        }
        modifiedContactUris.push(uri);

        if (entry.contacts[uri]) {
            entry.contacts[uri].contact = req.headers.contact[i];
        } else {
            entry.contacts[uri] = {
                contact: req.headers.contact[i]
            };
            entry.contactsOrdered.push(req.headers.contact[i]);
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

    const removed = [];
    _removeExpired(entry, tim, removed);

    // order by "q" param and expiration
    entry.contactsOrdered.sort((contact1, contact2) => {
        const q = (contact2.params.q ? +contact2.params.q : 0) - (contact1.params.q ? +contact1.params.q : 0);
        if (q === 0) { // equal
            return entry.contacts[contact2.uri].expiresAt - entry.contacts[contact1.uri].expiresAt;
        }
        return q;
    });

    if (failed.length > 0) {
        console.warn("REGISTER FAIL (bad uris)", req.headers.to.uri, failed);
    } else {
        console.debug("REGISTER OK", req.headers.to.uri, modifiedContactUris);
    }
    return entry;

}

function _removeExpired(entry, tim, removed) {
    let i = entry.contactsOrdered.length;
    while (i--) {
        const contact = entry.contactsOrdered[i];
        if (entry.contacts[contact.uri].expiresAt <= tim) {
            removed.push(entry.contacts[contact.uri]);
            entry.contactsOrdered.splice(i, 1)[0];
            delete entry.contacts[contact.uri];
        }
    }
}

// remove expired contacts
setInterval(() => {
    const tim = Date.now();
    let removed = [];
    for (const entry of _registry) {
        _removeExpired(entry, tim, removed);
    }
    console.debug(`Removed ${removed.length} expired registrations`, removed);
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
                //_registerInternal(req, remote, upRemote);

            } else {
                console.warn("REGISTER FAIL (bad response)", req, res);
            }

            // default proxy behaviour
            res.headers.via.shift();
            proxy.send(res);
        });
    } catch (err) {
        console.error("REGISTER FAIL (error)", err);
    }
};
const _registerHere = function (req, remote) {
    // we are the registrar ourselves
    const failed = [];
    const entry = _registerInternal(req, remote, null, failed);
    let res = null;
    if (failed.length === 0) {
        res = sip.makeResponse(req, 200, 'OK');
    } else {
        res = sip.makeResponse(req, 501, `Unable to recognize contacts ${JSON.stringify(failed)}, could be IPv6 which is unsupported`);
    }
    res.headers.contact = entry.contactsOrdered;
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
        for (const contact of entry.contactsOrdered) {
            const contactInfo = entry.contacts[contact.uri];
            if (contactInfo.expiresAt > tim) {
                ret.push(contact);
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

            console.debug("ROUTE", goodContact.uri);

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
            console.debug(req.method, req.uri);
            _route(req);
        }
    }

});

console.log(`Started sip proxy server on ${config.host}:${config.port}\n\n\n`);

