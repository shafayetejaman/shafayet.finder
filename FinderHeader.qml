import QtQuick
import qs.Commons
import qs.Ui

Rectangle {
  id: headerRoot

  property string filterText: ""
  property bool scanning: false
  property bool searching: false
  property bool invalid: false
  property int entryCount: 0
  property string fontFamily: Style.font.menuFamily
  property int headingSize: 16
  property int captionSize: 12
  property int contentSize: 13

  readonly property int barHeight: Math.max(Style.space(34),
    Style.spacing.controlPaddingY * 2 + contentSize)

  width: parent ? parent.width : 0
  height: barHeight
  radius: Style.cornerRadius
  color: "transparent"

  Text {
    anchors.left: parent.left
    anchors.right: statusLabel.visible ? statusLabel.left : parent.right
    anchors.rightMargin: statusLabel.visible ? Style.space(12) : 0
    anchors.verticalCenter: parent.verticalCenter
    text: headerRoot.filterText || "Search files…"
    textFormat: Text.PlainText
    color: Color.menu.text
    opacity: headerRoot.filterText ? 1 : 0.58
    font.family: headerRoot.fontFamily
    font.pixelSize: headerRoot.headingSize
    elide: Text.ElideRight
  }

  Text {
    id: statusLabel
    visible: headerRoot.invalid || headerRoot.searching || (!headerRoot.filterText && (headerRoot.scanning || headerRoot.entryCount > 0))
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    text: headerRoot.invalid ? "Invalid!" : headerRoot.searching ? "searching…" : headerRoot.scanning ? "scanning…" : headerRoot.entryCount.toLocaleString() + " entries"
    textFormat: Text.PlainText
    color: Color.menu.text
    opacity: 0.5
    font.family: headerRoot.fontFamily
    font.pixelSize: headerRoot.captionSize
  }
}
