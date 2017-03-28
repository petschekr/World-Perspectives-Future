import * as common from "../common";
import * as express from "express";
import * as moment from "moment";

export let dataRouter = express.Router();

const timeFormat: string = "h:mm A";
const dateFormat: string = "MMMM Do, YYYY";

let authenticateCheck = common.authenticateMiddleware;

dataRouter.route("/schedule").get(authenticateCheck, async (request, response) => {
	try {
		if (!response.locals.authenticated || !response.locals.user.registered) {
			// Generalized schedule for unknown or unregistered users
			let results: any[] = await common.cypherAsync({
				query: "MATCH (item:ScheduleItem) RETURN item.title AS title, item.start AS start, item.end AS end, item.location AS location, item.editable AS editable"
			});
			response.json(results.map(function (item) {
				let startTime = item.start;
				delete item.start;
				let endTime = item.end;
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
		}
		else {
			let sessions: any[] = await common.cypherAsync({
				"query": "MATCH (user:User {username: {username}})-[r:ATTENDS]->(s:Session) RETURN s.title AS title, s.slug AS slug, s.startTime AS start, s.endTime AS end, s.location AS location, s.type AS type, s.description AS description, true AS editable",
				"params": {
					username: response.locals.user.username
				}
			});

			let sessionsWithNames = await Promise.all(sessions.map(session => {
				return common.cypherAsync({
					"query": "MATCH (user:User)-[r:PRESENTS]->(s:Session {slug: {slug}}) RETURN user.name AS name, s.slug AS slug",
						"params": {
							slug: session.slug
						}
				});
			}));
			let items = await common.cypherAsync({
				query: "MATCH (item:ScheduleItem) RETURN item.title AS title, item.start AS start, item.end AS end, item.location AS location, item.editable AS editable"
			});
			function formatter (item: any) {
				let startTime = item.start;
				delete item.start;
				let endTime = item.end;
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
						if (moment(sessions[j].start).isSame(moment(items[i].start))) {
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
								let aSplit = a.toLowerCase().split(" ");
								let bSplit = b.toLowerCase().split(" ");
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
		}
	}
	catch (err) {
		common.handleError(response, err);
	}
});
dataRouter.route("/sessions").get(async (request, response) => {
	try {
		let results: any[] = await common.cypherAsync({
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
		});
		let sessions = await Promise.all(results.map(async session => {
			let sessionRelationships = await common.cypherAsync({
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
			});
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
		}));
		response.json(sessions);
	}
	catch (err) {
		common.handleError(response, err);
	}
});
dataRouter.route("/date").get(async (request, response) => {
	try {
		response.json({
			"formatted": (await common.getSymposiumDate()).format(dateFormat)
		});
	}
	catch (err) {
		common.handleError(response, err);
	}
});
