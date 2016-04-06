import Promise = require("bluebird");
import common = require("../common");
var db = common.db;
import express = require("express");
var router = express.Router();
import moment = require("moment");

const timeFormat: string = "h:mm A";
const dateFormat: string = "MMMM Do, YYYY";

var authenticateCheck = common.authenticateMiddleware;

router.route("/schedule").get(authenticateCheck, function (request, response) {
	if (!response.locals.authenticated || !response.locals.user.registered) {
		// Generalized schedule for unknown or unregistered users
		db.cypherAsync({
			query: "MATCH (item:ScheduleItem) RETURN item.title AS title, item.start AS start, item.end AS end, item.location AS location, item.editable AS editable"
		}).then(function (results) {
			response.json(results.map(function (item) {
				var startTime = item.start;
				delete item.start;
				var endTime = item.end;
				delete item.end;
				item.time = {
					"start": {
						"raw": startTime,
						"formatted": moment(startTime).format(timeFormat)
					},
					"end": {
						"raw": endTime,
						"formatted": moment(endTime).format(timeFormat)
					}
				};
				return item;
			}));
		}).catch(common.handleError.bind(response));
	}
	else {
		db.cypherAsync({
			"query": "MATCH (user:User {username: {username}})-[r:ATTENDS]->(s:Session) RETURN s.title AS title, s.slug AS slug, s.startTime AS start, s.endTime AS end, s.location AS location, s.type AS type, s.description AS description, true AS editable",
			"params": {
				username: response.locals.user.username
			}
		}).then(function (attendingSessions: any[]) {
			return Promise.map(attendingSessions, function (attendingSession) {
				return db.cypherAsync({
					"query": "MATCH (user:User)-[r:PRESENTS]->(s:Session {slug: {slug}}) RETURN user.name AS name, s.slug AS slug",
						"params": {
							slug: attendingSession.slug
						}
				});
			}).then(function (sessionsWithNames) {
				return db.cypherAsync({
					query: "MATCH (item:ScheduleItem) RETURN item.title AS title, item.start AS start, item.end AS end, item.location AS location, item.editable AS editable"
				}).then(function (items) {
					return Promise.resolve([items, attendingSessions, sessionsWithNames]);
				});
			});
		}).spread(function (items, sessions, sessionsWithNames) {
			function formatter (item) {
				var startTime = item.start;
				delete item.start;
				var endTime = item.end;
				delete item.end;
				item.time = {
					"start": {
						"raw": startTime,
						"formatted": moment(startTime).format(timeFormat)
					},
					"end": {
						"raw": endTime,
						"formatted": moment(endTime).format(timeFormat)
					}
				};
				return item;
			}
			// Flatten array
			sessionsWithNames = [].concat.apply([], sessionsWithNames);
			for (let i = 0; i < items.length; i++) {
				// Insert registration choices into schedule at editable periods
				if (items[i].editable) {
					let set = false;
					for (let j = 0; j < sessions.length; j++) {
						if (sessions[j].start === items[i].start) {
							items[i] = sessions[j];
							set = true;
							let people = [];
							for (let k = 0; k < sessionsWithNames.length; k++) {
								if (sessionsWithNames[k].slug === sessions[j].slug) {
									people.push(sessionsWithNames[k].name);
								}
							}
							// Sort people by last name
							people = people.sort(function (a, b) {
								var aSplit = a.toLowerCase().split(" ");
								var bSplit = b.toLowerCase().split(" ");
								a = aSplit[aSplit.length - 1];
								b = bSplit[bSplit.length - 1];
								if (a < b) return -1;
								if (a > b) return 1;
								return 0;
							});
							items[i].people = people.join(", ");
							// Return type of form "Global" or "Science" instead of including "session" at the end
							if (items[i].type)
								items[i].type = items[i].type.split(" ")[0];
							break;
						}
					}
					if (!set) {
						// Couldn't find registered session for this editable time so it must be a free
						items[i].title = "Free";
					}
				}
			}
			response.json(items.map(formatter));
		}).catch(common.handleError.bind(response));
	}
});
router.route("/sessions").get(function (request, response) {
	db.cypherAsync({
		query: `MATCH (s:Session) RETURN
			s.title AS title,
			s.slug AS slug,
			s.description AS description,
			s.type AS type,
			s.location AS location,
			s.capacity AS capacity,
			s.attendees AS attendees,
			s.startTime AS startTime,
			s.endTime AS endTime
			ORDER BY s.startTime, lower(s.title)`
	}).then(function (results) {
		return Promise.map(results, function (session: any) {
			return db.cypherAsync({
				queries: [{
					query: "MATCH (user:User)-[r:PRESENTS]->(s:Session {slug: { slug }}) RETURN user.username AS username, user.name AS name ORDER BY last(split(user.name, \" \"))",
					params: {
						slug: session.slug
					}
				}, {
					query: "MATCH (user:User)-[r:MODERATES]->(s:Session {slug: { slug }}) RETURN user.username AS username, user.name AS name",
					params: {
						slug: session.slug
					}
				}]
			}).then(function (sessionRelationships) {
				return {
					"title": {
						"formatted": session.title,
						"slug": session.slug
					},
					"description": session.description,
					"type": session.type,
					"location": session.location,
					"capacity": {
						"total": session.capacity,
						"filled": session.attendees
					},
					"time": {
						"start": {
							"raw": session.startTime,
							"formatted": moment(session.startTime).format(timeFormat)
						},
						"end": {
							"raw": session.endTime,
							"formatted": moment(session.endTime).format(timeFormat)
						},
						"date": moment(session.startTime).format(dateFormat)
					},
					"presenters": sessionRelationships[0],
					"moderator": (sessionRelationships[1].length !== 0) ? sessionRelationships[1][0] : null
				};
			});
		});
	})
	.then(function (sessions) {
		response.json(sessions);
	})
	.catch(common.handleError.bind(response));
});
router.route("/date").get(function (request, response) {
    common.getSymposiumDate().then(function (date: moment.Moment) {
		response.json({
			"formatted": date.format(dateFormat)
		});
	}).catch(common.handleError.bind(response));
});

export = router;